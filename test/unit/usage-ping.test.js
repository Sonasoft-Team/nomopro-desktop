const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sendUsagePing, getInstallId, PING_URL } = require("../../src/main/usage-ping");

describe("Usage ping", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomopro-usage-ping-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/version.json"), JSON.stringify({ gui: "v1.2.0" }));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.NOMOKIT_NO_USAGE_PING;
  });

  const run = (extra = {}) => {
    const calls = [];
    return sendUsagePing({
      userDataDir: dir,
      appRoot: dir,
      appVersion: "4.0.8",
      packaged: true,
      post: async (url, body) => calls.push({ url, body }),
      ...extra,
    }).then((ok) => ({ ok, calls }));
  };

  it("keeps the same install ID across launches", async () => {
    const a = await run();
    const b = await run();
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.calls[0].url, PING_URL);
    assert.match(a.calls[0].body.install_id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(a.calls[0].body.install_id, b.calls[0].body.install_id);
    assert.deepStrictEqual(
      { app: a.calls[0].body.app, gui: a.calls[0].body.gui, platform: a.calls[0].body.platform },
      { app: "4.0.8", gui: "v1.2.0", platform: process.platform },
    );
  });

  it("replaces a corrupt install-id file", () => {
    fs.writeFileSync(path.join(dir, "install-id"), "garbage");
    const id = getInstallId(dir);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(getInstallId(dir), id);
  });

  it("sends nothing in dev or when opted out", async () => {
    assert.strictEqual((await run({ packaged: false })).calls.length, 0);
    process.env.NOMOKIT_NO_USAGE_PING = "1";
    assert.strictEqual((await run()).calls.length, 0);
  });

  it("never throws when the request fails", async () => {
    const { ok } = await run({ post: async () => { throw new Error("offline"); } });
    assert.strictEqual(ok, false);
  });
});
