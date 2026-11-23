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
