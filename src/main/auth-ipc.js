const { ipcMain, BrowserWindow } = require("electron");
const { getAuth } = require("./auth-instance");

// getWin is kept for symmetry with registerIpc; broadcasts go to every window.
function registerAuthIpc({ getWin } = {}) {
  const auth = getAuth();

  ipcMain.handle("auth:get-session", () => auth.getSession());
  ipcMain.handle("auth:login", async () => {
    try {
      return { ok: true, session: await auth.login() };
    } catch (e) {
      return { ok: false, code: (e && e.code) || "error", message: e && e.message };
    }
  });
  ipcMain.handle("auth:logout", () => auth.logout());
  ipcMain.handle("auth:get-kits", () => auth.getKits());

  auth.onChange(() => {
    const session = auth.getSession();
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || (w.getParentWindow && w.getParentWindow())) continue;
      w.webContents.send("auth:changed", session || null);
    }
  });
}

module.exports = { registerAuthIpc };
