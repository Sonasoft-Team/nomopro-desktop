const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAuth } = require("../../src/main/auth");

const DAY = 24 * 3600 * 1000;
const FULL_USER = { id: 7, name: "Budi", email: "b@x.id", avatar: "a.png", password: "secret", role: "x" };

describe("Main-process auth", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomopro-auth-"));
    fs.mkdirSync(path.join(dir, "data"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const userFile = () => path.join(dir, "data", "user.json");
  const cacheFile = () => path.join(dir, "data", "kits-cache.json");
  const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  const netErr = () => Object.assign(new Error("offline"), { code: "ENOTFOUND" });
  const httpErr = (status) => Object.assign(new Error("http " + status), { response: { status } });

  const make = (over = {}) => {
    const calls = [];
    const socket = {
      connected: false,
      events: [],
      connect() { this.connected = true; this.events.push(["connect"]); },
      emit(...a) { this.events.push(["emit", ...a]); },
      disconnect() { this.connected = false; this.events.push(["disconnect"]); },
    };
    const http = {
      post: async (url, body, cfg) => { calls.push(["post", url, body, cfg]); return { status: 204, data: "" }; },
      get: async (url, cfg) => {
        calls.push(["get", url, cfg]);
        if (url.endsWith("/api/user")) return { data: FULL_USER };
        if (url.endsWith("/api/me/kits"))
          return { data: { is_active_subs: true, kit_external_id: ["k1"], access_until: "2026-12-01T00:00:00Z" } };
        throw new Error("unexpected " + url);
      },
      ...over.http,
    };
    const auth = createAuth({
      appRoot: dir,
      http,
      getHwid: () => "HW1",
      socketFactory: () => socket,
      openLoginWindow: async () => ({ token: "T1", user: { id: 7 } }),
      now: () => new Date("2026-11-23T00:00:00Z"),
      logger: { info() {}, warn() {}, error() {} },
      ...over.deps,
    });
    return { auth, calls, socket };
  };

  const seedSession = () =>
    fs.writeFileSync(userFile(), JSON.stringify({ user: FULL_USER, token: "T1" }));

  it("completeLogin binds hwid, saves the /api/user shape with token, emits socket login with that object", async () => {
    const { auth, calls, socket } = make();
    let changes = 0;
    auth.onChange(() => changes++);
    await auth.completeLogin({ token: "T1", user: { id: 7 } });
    const bind = calls.find((c) => c[1].endsWith("/api/desktop/bind"));
    assert.deepStrictEqual(bind[2], { hwid: "HW1", app: "nomopro" });
    assert.strictEqual(bind[3].headers.Authorization, "Bearer T1");
    assert.deepStrictEqual(readJson(userFile()), { user: FULL_USER, token: "T1" });
    assert.ok(socket.events.some((e) => e[0] === "connect"));
    const em = socket.events.find((e) => e[0] === "emit");
    assert.strictEqual(em[1], "login");
    assert.deepStrictEqual(em[2], { user: FULL_USER, token: "T1" });
    assert.strictEqual(changes, 1);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, "data")), ["user.json"]);
  });

  it("login rejects with code cancelled when the window closes, propagates other codes", async () => {
    const cancelled = make({ deps: { openLoginWindow: async () => null } });
    await assert.rejects(cancelled.auth.login(), (e) => e instanceof Error && e.code === "cancelled");
    const boom = make({
      deps: { openLoginWindow: async () => { throw Object.assign(new Error("x"), { code: "blocked" }); } },
    });
    await assert.rejects(boom.auth.login(), (e) => e.code === "blocked");
  });

  it("login completes and returns the public session", async () => {
    const { auth } = make();
    const s = await auth.login();
    assert.deepStrictEqual(s, { token: "T1", user: { id: 7, name: "Budi", email: "b@x.id", avatar: "a.png" } });
  });

  it("getSession returns public user fields only", () => {
    const { auth } = make();
    assert.strictEqual(auth.getSession(), null);
    seedSession();
    assert.deepStrictEqual(auth.getSession(), {
      token: "T1",
      user: { id: 7, name: "Budi", email: "b@x.id", avatar: "a.png" },
    });
    fs.writeFileSync(userFile(), "{}");
    assert.strictEqual(auth.getSession(), null);
  });

  it("getKits caches the server answer", async () => {
    seedSession();
    const { auth, calls } = make();
    const r = await auth.getKits();
    assert.deepStrictEqual(r, { is_active_subs: true, kit_external_id: ["k1"] });
    assert.strictEqual(calls[0][2].headers.Authorization, "Bearer T1");
    const c = readJson(cacheFile());
    assert.deepStrictEqual(
      { k: c.kit_external_id, s: c.is_active_subs, a: c.access_until },
      { k: ["k1"], s: true, a: "2026-12-01T00:00:00Z" },
    );
    assert.ok(c.fetched_at);
  });

  const offlineHttp = { get: async () => { throw netErr(); } };

  it("getKits offline uses cache and keeps subscription within 7 days after access_until", async () => {
    seedSession();
    fs.writeFileSync(cacheFile(), JSON.stringify({ kit_external_id: [], is_active_subs: true, access_until: "2026-11-18T00:00:00Z" }));
    const { auth } = make({ http: offlineHttp });
    assert.deepStrictEqual(await auth.getKits(), { is_active_subs: true, kit_external_id: [] });
  });

  it("getKits offline drops subscription after the grace period but keeps bought kits", async () => {
    seedSession();
    fs.writeFileSync(cacheFile(), JSON.stringify({ kit_external_id: [], is_active_subs: true, access_until: "2026-11-10T00:00:00Z" }));
    let m = make({ http: offlineHttp });
    assert.deepStrictEqual(await m.auth.getKits(), { is_active_subs: false, kit_external_id: [] });
    fs.writeFileSync(cacheFile(), JSON.stringify({ kit_external_id: ["k9"], is_active_subs: false, access_until: null }));
    m = make({ http: offlineHttp });
    assert.deepStrictEqual(await m.auth.getKits(), { is_active_subs: true, kit_external_id: ["k9"] });
  });

  it("getKits offline with no cache, or a non-401 http error, falls back to cache/empty", async () => {
    seedSession();
    let m = make({ http: offlineHttp });
    assert.deepStrictEqual(await m.auth.getKits(), { is_active_subs: false, kit_external_id: [] });
    fs.writeFileSync(cacheFile(), JSON.stringify({ kit_external_id: ["k2"], is_active_subs: false, access_until: null }));
    m = make({ http: { get: async () => { throw httpErr(500); } } });
    assert.deepStrictEqual(await m.auth.getKits(), { is_active_subs: true, kit_external_id: ["k2"] });
    assert.ok(m.auth.getSession(), "session kept on 500");
  });

  it("getKits 401 clears session and cache", async () => {
    seedSession();
    fs.writeFileSync(cacheFile(), JSON.stringify({ kit_external_id: ["k2"], is_active_subs: true, access_until: null }));
    const { auth, calls, socket } = make({ http: { get: async () => { throw httpErr(401); } } });
    let changes = 0;
    auth.onChange(() => changes++);
    assert.deepStrictEqual(await auth.getKits(), { is_active_subs: false, kit_external_id: [] });
    assert.strictEqual(auth.getSession(), null);
    assert.ok(!fs.existsSync(cacheFile()));
    assert.ok(!calls.some((c) => c[1].endsWith("/api/logout")), "no API call");
    assert.strictEqual(changes, 1);
    assert.ok(socket.events.some((e) => e[0] === "disconnect") || socket.events.length === 0);
  });

  it("getKits without a session returns empty without calling the API", async () => {
    const { auth, calls } = make();
    assert.deepStrictEqual(await auth.getKits(), { is_active_subs: false, kit_external_id: [] });
    assert.strictEqual(calls.length, 0);
  });

  it("logout clears user.json and cache even when the API call fails", async () => {
    seedSession();
    fs.writeFileSync(cacheFile(), JSON.stringify({ kit_external_id: ["k"], is_active_subs: true, access_until: null }));
    const { auth, socket } = make({ http: { post: async () => { throw netErr(); } } });
    socket.connected = true;
    let changes = 0;
    auth.onChange(() => changes++);
    await auth.logout();
    assert.strictEqual(auth.getSession(), null);
    assert.ok(!fs.existsSync(cacheFile()));
    const em = socket.events.find((e) => e[0] === "emit");
    assert.deepStrictEqual(em.slice(1), ["logout", "T1"]);
    assert.ok(socket.events.some((e) => e[0] === "disconnect"));
    assert.strictEqual(changes, 1);
  });

  it("start connects the socket only when logged in", () => {
    let m = make();
    m.auth.start();
    assert.strictEqual(m.socket.events.length, 0);
    seedSession();
    m = make();
    m.auth.start();
    assert.ok(m.socket.events.some((e) => e[0] === "connect"));
  });

  it("onChange returns an unsubscribe", async () => {
    const { auth } = make();
    let n = 0;
    const off = auth.onChange(() => n++);
    off();
    await auth.completeLogin({ token: "T1" });
    assert.strictEqual(n, 0);
  });
});
