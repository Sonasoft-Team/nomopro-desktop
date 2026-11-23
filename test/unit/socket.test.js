const assert = require("assert");
const Module = require("module");

// socket.js pulls electron (dialog) and auth-instance at load; stub both.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { dialog: { showErrorBox() {} } };
  if (request === "./auth-instance") return { getAuth: () => ({}) };
  if (request === "./logger") return { info() {}, warn() {}, error() {} };
  return origLoad.call(this, request, ...rest);
};
const { initSocket } = require("../../src/main/socket");
Module._load = origLoad;

describe("socket one-device rule", () => {
  const setup = (session) => {
    const handlers = {};
    const socket = { on: (ev, cb) => (handlers[ev] = cb) };
    const logouts = [];
    const errors = [];
    const auth = {
      onSocket: (cb) => cb(socket),
      getSession: () => session,
      logout: (opts) => logouts.push(opts),
    };
    initSocket({ auth, showError: (...a) => errors.push(a) });
    return { handlers, logouts, errors };
  };

  it("login-fail with the current token logs out locally and shows the message once", () => {
    const { handlers, logouts, errors } = setup({ token: "T1", user: {} });
    handlers["login-fail"]("T1");
    assert.deepStrictEqual(logouts, [{ local: true }]);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0][1].includes("Seseorang telah login"));
  });

  it("login-fail with a different token does nothing", () => {
    const { handlers, logouts, errors } = setup({ token: "T1", user: {} });
    handlers["login-fail"]("OTHER");
    assert.strictEqual(logouts.length, 0);
    assert.strictEqual(errors.length, 0);
  });

  it("login-fail without a session does nothing", () => {
    const { handlers, logouts, errors } = setup(null);
    handlers["login-fail"]("T1");
    assert.strictEqual(logouts.length, 0);
    assert.strictEqual(errors.length, 0);
  });
});
