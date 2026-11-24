const { ipcMain, dialog, app } = require("electron");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { getAuth } = require("./auth-instance");
const { isTrustedSender } = require("./auth-ipc");

// The legacy handlers hand out the session token: app frames only, never a
// remote subframe (e.g. an embedded video).
const fromApp = (event) => isTrustedSender(event, { packaged: app.isPackaged });

// Default storage path: Documents/OpenBlock (Windows) or ~/Documents/OpenBlock (macOS)
const getDefaultStorageDir = () => {
  const docsDir = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Documents")
    : process.env.HOME
      ? path.join(process.env.HOME, "Documents")
      : path.join(__dirname, "..", "..", "data", "projects");

  const storageDir = path.join(docsDir, "Nomokit");
  return storageDir;
};

const ensureDefaultStorageDir = () => {
  const dir = getDefaultStorageDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch (e) {
    // If Documents path fails, fallback to app-local data
    const fallback = path.join(__dirname, "..", "..", "data", "projects");
    try {
      if (!fs.existsSync(fallback)) {
        fs.mkdirSync(fallback, { recursive: true });
      }
    } catch (e2) {
      logger.error(`Failed to create fallback directory: ${e2.message}`);
    }
    return fallback;
  }
};

const registerFileStorageHandlers = () => {
  ipcMain.handle("file-storage-save", async (event, { fileName, content }) => {
    try {
      const dir = ensureDefaultStorageDir();
      // Validate extension
      const safeName = path.basename(fileName || "untitled.txt");
      const targetPath = path.join(dir, safeName);

      // Conflict handling: if file exists, rename with (1), (2), etc.
      let finalPath = targetPath;
      let counter = 1;
      while (fs.existsSync(finalPath) && counter < 1000) {
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        finalPath = path.join(dir, `${base} (${counter})${ext}`);
        counter++;
      }

      fs.writeFileSync(finalPath, content, "utf8");
      logger.info(`File saved: ${finalPath}`);
      return {
        success: true,
        path: finalPath,
        fileName: path.basename(finalPath),
      };
    } catch (e) {
      logger.error(`File save error: ${e.message}`);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("file-storage-read", async (event, { fileName }) => {
    try {
      const dir = getDefaultStorageDir();
      const targetPath = path.join(dir, path.basename(fileName || ""));
      if (!fs.existsSync(targetPath)) {
        return { success: false, error: "File not found" };
      }
      const content = fs.readFileSync(targetPath, "utf8");
      return { success: true, content, path: targetPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("file-storage-list", async () => {
    try {
      const dir = ensureDefaultStorageDir();
      const files = fs.readdirSync(dir).filter((f) => {
        const fullPath = path.join(dir, f);
        return fs.statSync(fullPath).isFile();
      });
      const fileInfos = files.map((f) => {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        return {
          name: f,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      });
      return { success: true, files: fileInfos, dir };
    } catch (e) {
      return { success: false, error: e.message, files: [] };
    }
  });

  ipcMain.handle("file-storage-delete", async (event, { fileName }) => {
    try {
      const dir = getDefaultStorageDir();
      const targetPath = path.join(dir, path.basename(fileName || ""));
      if (!fs.existsSync(targetPath)) {
        return { success: false, error: "File not found" };
      }
      fs.unlinkSync(targetPath);
      logger.info(`File deleted: ${targetPath}`);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("file-storage-get-default-dir", async () => {
    const dir = ensureDefaultStorageDir();
    return { success: true, dir };
  });
};

function registerIpc({ win, appRoot }) {
  // Renderer errors -> main log. Throttle identical messages per frame so a
  // render loop can't flood nomopro.log.
  const rendererErrSeen = new Map();
  ipcMain.on("renderer-error", (event, arg) => {
    const a = arg || {};
    const key = `${a.kind}|${a.source}|${a.line}|${a.message}`;
    const now = Date.now();
    const last = rendererErrSeen.get(key) || 0;
    if (now - last < 5000) return;
    rendererErrSeen.set(key, now);
    if (rendererErrSeen.size > 200) {
      for (const [k, ts] of rendererErrSeen) {
        if (now - ts > 60000) rendererErrSeen.delete(k);
      }
    }
    logger.error(
      `[renderer:${a.kind || "error"}] ${a.message || "unknown"} ` +
        `(${a.source || a.url || "?"}:${a.line || 0}:${a.column || 0})` +
        (a.stack ? `\n${a.stack}` : ""),
    );
  });

  // Old GUI builds still send "logout" / ask for the user: answer from the
  // shared auth session. Never relaunches or navigates the window.
  ipcMain.on("logout", (event) => {
    if (!fromApp(event)) return;
    getAuth().logout();
  });

  // Legacy getUserData (send-based) — keep for backward compat
  ipcMain.on("getUserData", (event) => {
    if (!fromApp(event)) return; // no reply: it would land in the main frame
    const session = getAuth().getSession();
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send("responseUserData", session ? { id: session.user.id } : {});
    }
  });

  // New invoke-based getUserData for preload bridge
  ipcMain.handle("getUserData", async (event) => {
    if (!fromApp(event)) return {};
    const session = getAuth().getSession();
    if (!session) return {};
    return {
      id: session.user.id,
      name: session.user.name || "",
      token: session.token,
    };
  });

  // Register file storage handlers
  registerFileStorageHandlers();
}

module.exports = { registerIpc };
