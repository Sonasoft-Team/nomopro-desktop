const { dialog } = require("electron");
const logger = require("./logger");
const { getAuth } = require("./auth-instance");

// One-device rule: the server tells a socket "login-fail <token>" when the same
// account logs in somewhere else. Only that case matters here; connecting or
// dropping never navigates the window (the IDE works offline and logged out).
function initSocket({ auth = getAuth(), showError = dialog.showErrorBox } = {}) {
  auth.onSocket((socket) => {
    socket.on("login-fail", (data) => {
      try {
        const session = auth.getSession();
        if (!session || data !== session.token) return;
        auth.logout({ local: true }); // server already dropped us: no emit, no API call
        showError(
          "Error: ",
          "Seseorang telah login dengan akun anda, silahkan login kembali",
        );
      } catch (err) {
        logger.error("login-fail handler error: " + err.message);
      }
    });
  });
}

module.exports = { initSocket };
