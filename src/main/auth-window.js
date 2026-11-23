const path = require("path");
const { BrowserWindow, ipcMain, shell } = require("electron");

const ORIGIN = "https://nomo-kit.com";
const LOGIN_URL = `${ORIGIN}/auth/popup?client=desktop`;

function isAllowedLoginUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.origin === ORIGIN;
  } catch (e) {
    return false;
  }
}

function isExternalOpenable(url) {
  try {
    const p = new URL(url).protocol;
    return p === "https:" || p === "http:";
  } catch (e) {
    return false;
  }
}

let current = null; // { win, promise }

// Opens the modal login pop-up. Resolves {token, user}; rejects with
// code 'cancelled' if the window is closed first. One window at a time.
function openLoginWindow(parentWin) {
  if (current && !current.win.isDestroyed()) {
    current.win.focus();
    return current.promise;
  }

  const hasParent = parentWin && !parentWin.isDestroyed();
  const win = new BrowserWindow({
    width: 440,
    height: 640,
    parent: hasParent ? parentWin : undefined,
    modal: !!hasParent,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload-auth.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  const wc = win.webContents;

  const promise = new Promise((resolve, reject) => {
    let settled = false;

    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(message), { code }));
      if (!win.isDestroyed()) win.close();
    };

    const onComplete = (event, payload) => {
      if (event.sender !== wc || settled) return;
      const frame = event.senderFrame;
      if (!frame || frame !== wc.mainFrame) return;
      if (!isAllowedLoginUrl(frame.url)) return;
      if (!payload || typeof payload.token !== "string" || !payload.token) return;
      settled = true;
      resolve({ token: payload.token, user: payload.user });
      if (!win.isDestroyed()) win.close();
    };
    ipcMain.on("auth:complete", onComplete);

    const showOnce = () => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    };
    win.once("ready-to-show", showOnce);
    wc.on("did-finish-load", showOnce);
    win.on("closed", () => {
      ipcMain.removeListener("auth:complete", onComplete);
      current = null;
      if (!settled) {
        settled = true;
        reject(Object.assign(new Error("Login cancelled"), { code: "cancelled" }));
      }
    });

    const external = (url) => {
      if (isExternalOpenable(url)) {
        Promise.resolve(shell.openExternal(url)).catch(() => {});
      }
    };
    wc.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: "deny" };
    });
    const guard = (event, url) => {
      if (!isAllowedLoginUrl(url)) {
        event.preventDefault();
        external(url);
      }
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);

    wc.on("did-fail-load", (event, code, desc, url, isMainFrame) => {
      if (code === -3 || !isMainFrame) return; // -3 = aborted (e.g. our own preventDefault)
      fail("network", `Login page failed to load: ${desc}`);
    });
    win.loadURL(LOGIN_URL).catch((e) => fail("network", e.message));
  });

  current = { win, promise };
  return promise;
}

function getLoginWebContents() {
  return current && !current.win.isDestroyed() ? current.win.webContents : null;
}

module.exports = { openLoginWindow, getLoginWebContents, isAllowedLoginUrl, isExternalOpenable, LOGIN_URL };
