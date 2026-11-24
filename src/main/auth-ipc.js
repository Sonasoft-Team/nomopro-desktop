const { ipcMain, BrowserWindow, app } = require("electron");
const { getAuth } = require("./auth-instance");
const { getLoginWebContents } = require("./auth-window");

// The session token reaches the renderer by design, so only the app's own
// pages may ask for it: bundled file: pages, or the GUI dev server unpackaged.
function isTrustedAppUrl(url, { packaged } = {}) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return true;
    return !packaged && u.origin === "http://127.0.0.1:8601";
  } catch (e) {
    return false;
  }
}

const trusted = (url) => isTrustedAppUrl(url, { packaged: app.isPackaged });
const senderOk = (event) => !!event.senderFrame && trusted(event.senderFrame.url);
const guarded = (fn) => (event, ...args) =>
  senderOk(event) ? fn(...args) : { ok: false, code: "forbidden" };

// wc.send() only reaches a window's main frame; the ML and C++ iframes run the
// preload too and must hear auth changes, so send to every trusted frame.
function broadcastAuthChanged(windows, session, { isTrusted, loginWebContents = null }) {
  for (const w of windows) {
    if (w.isDestroyed()) continue;
    const wc = w.webContents;
    if (wc === loginWebContents) continue;
    if (!isTrusted(wc.mainFrame.url)) continue;
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (!isTrusted(frame.url)) continue;
      try {
        frame.send("auth:changed", session || null);
      } catch (e) {
        /* frame went away mid-broadcast */
      }
    }
  }
}

function registerAuthIpc() {
  const auth = getAuth();

  ipcMain.handle("auth:get-session", guarded(() => auth.getSession()));
  ipcMain.handle(
    "auth:login",
    guarded(async () => {
      try {
        return { ok: true, session: await auth.login() };
      } catch (e) {
        return { ok: false, code: (e && e.code) || "error", message: e && e.message };
      }
    }),
  );
  ipcMain.handle("auth:logout", guarded(() => auth.logout()));
  ipcMain.handle("auth:get-kits", guarded(() => auth.getKits()));

  auth.onChange(() => {
    broadcastAuthChanged(BrowserWindow.getAllWindows(), auth.getSession(), {
      isTrusted: trusted,
      loginWebContents: getLoginWebContents(),
    });
  });
}

module.exports = { registerAuthIpc, isTrustedAppUrl, broadcastAuthChanged };
