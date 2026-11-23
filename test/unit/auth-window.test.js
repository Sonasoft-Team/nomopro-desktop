const assert = require("assert");
const { isAllowedLoginUrl, isExternalOpenable } = require("../../src/main/auth-window");

describe("Login window URL policy", () => {
  it("allows the pop-up and other nomo-kit.com https pages", () => {
    assert.strictEqual(isAllowedLoginUrl("https://nomo-kit.com/auth/popup?client=desktop"), true);
    assert.strictEqual(isAllowedLoginUrl("https://nomo-kit.com/"), true);
  });
  it("rejects look-alike and non-https URLs", () => {
    for (const u of [
      "http://nomo-kit.com/",
      "https://nomo-kit.com.evil.com/",
      "https://evil.com/?https://nomo-kit.com/",
      "https://user@evil.com/",
      "https://www.nomo-kit.com/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not a url",
      "",
      undefined,
    ]) {
      assert.strictEqual(isAllowedLoginUrl(u), false, String(u));
    }
  });
  it("only hands http/https URLs to the system browser", () => {
    assert.strictEqual(isExternalOpenable("https://nomo-kit.com/register"), true);
    assert.strictEqual(isExternalOpenable("http://example.com"), true);
    assert.strictEqual(isExternalOpenable("javascript:alert(1)"), false);
    assert.strictEqual(isExternalOpenable("file:///x"), false);
  });
});
