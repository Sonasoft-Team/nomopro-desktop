const assert = require("assert");
const { isTrustedAppUrl } = require("../../src/main/auth-ipc");

describe("isTrustedAppUrl", () => {
  it("trusts bundled file: pages", () => {
    assert.strictEqual(isTrustedAppUrl("file:///x/index.html", { packaged: true }), true);
  });
  it("trusts the GUI dev server only when unpackaged", () => {
    assert.strictEqual(isTrustedAppUrl("http://127.0.0.1:8601/", { packaged: false }), true);
    assert.strictEqual(isTrustedAppUrl("http://127.0.0.1:8601/", { packaged: true }), false);
  });
  it("rejects remote origins and garbage", () => {
    for (const u of ["https://nomo-kit.com/", "https://youtube.com/", "http://127.0.0.1:8602/", "", undefined, "nope"]) {
      assert.strictEqual(isTrustedAppUrl(u, { packaged: false }), false, String(u));
    }
  });
});

describe("broadcastAuthChanged", () => {
  const { broadcastAuthChanged } = require("../../src/main/auth-ipc");
  const frame = (url) => ({ url, got: [], send(ch, v) { this.got.push([ch, v]); } });
  const win = (frames, destroyed = false) => {
    const wc = { mainFrame: { url: frames[0].url, framesInSubtree: frames } };
    return { isDestroyed: () => destroyed, webContents: wc };
  };
  const isTrusted = (u) => isTrustedAppUrl(u, { packaged: true });
  const S = { token: "T", user: { id: 1 } };

  it("reaches the trusted main frame and trusted subframes, not untrusted ones", () => {
    const main = frame("file:///app/index.html");
    const ml = frame("file:///app/nomokit-ml/index.html");
    const yt = frame("https://youtube.com/embed/x");
    broadcastAuthChanged([win([main, ml, yt])], S, { isTrusted });
    assert.deepStrictEqual(main.got, [["auth:changed", S]]);
    assert.deepStrictEqual(ml.got, [["auth:changed", S]]);
    assert.deepStrictEqual(yt.got, []);
  });

  it("skips the login window, destroyed windows and untrusted main frames; sends null when logged out", () => {
    const login = frame("https://nomo-kit.com/auth/popup");
    const loginWin = win([login]);
    const gone = frame("file:///x");
    const remote = frame("https://evil.com/");
    const sub = frame("file:///y");
    const ok = frame("file:///z");
    broadcastAuthChanged(
      [loginWin, win([gone], true), win([remote, sub]), win([ok])],
      undefined,
      { isTrusted, loginWebContents: loginWin.webContents },
    );
    assert.deepStrictEqual([login.got, gone.got, remote.got, sub.got], [[], [], [], []]);
    assert.deepStrictEqual(ok.got, [["auth:changed", null]]);
  });

  it("a frame whose send throws does not stop the others", () => {
    const bad = frame("file:///a");
    bad.send = () => { throw new Error("detached"); };
    const good = frame("file:///b");
    broadcastAuthChanged([win([bad, good])], S, { isTrusted });
    assert.deepStrictEqual(good.got, [["auth:changed", S]]);
  });
});

describe("isTrustedSender", () => {
  const { isTrustedSender } = require("../../src/main/auth-ipc");
  const ev = (url) => ({ senderFrame: url === undefined ? null : { url } });
  it("accepts the app's own frames only", () => {
    assert.strictEqual(isTrustedSender(ev("file:///app/index.html"), { packaged: true }), true);
    assert.strictEqual(isTrustedSender(ev("http://127.0.0.1:8601/"), { packaged: false }), true);
    assert.strictEqual(isTrustedSender(ev("http://127.0.0.1:8601/"), { packaged: true }), false);
    assert.strictEqual(isTrustedSender(ev("https://youtube.com/embed/x"), { packaged: true }), false);
    assert.strictEqual(isTrustedSender(ev(undefined), { packaged: true }), false);
    assert.strictEqual(isTrustedSender({}, { packaged: true }), false);
  });
});
