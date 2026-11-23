const fs = require("fs");
const path = require("path");

const BASE_URL = "https://nomo-kit.com";
const HTTP_TIMEOUT_MS = 10000;
const GRACE_MS = 7 * 24 * 3600 * 1000;
const EMPTY_KITS = () => ({ is_active_subs: false, kit_external_id: [] });

// Optional desktop session: login completion, logout, the socket one-device
// rule and an offline kit cache. Never touches a BrowserWindow.
function createAuth({
  appRoot,
  http,
  getHwid,
  socketFactory,
  openLoginWindow,
  now = () => new Date(),
  logger,
}) {
  const userPath = path.join(appRoot, "data", "user.json");
  const cachePath = path.join(appRoot, "data", "kits-cache.json");
  const listeners = new Set();
  const socketListeners = new Set();
  let socket = null;

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      return null;
    }
  };

  // Write temp file + rename so a crash can't leave a half-written file.
  const writeJsonAtomic = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch (_) {
        /* ignore */
      }
      throw e;
    }
  };

  const removeFile = (file) => {
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      logger.error(`Failed to remove ${file}: ${e.message}`);
    }
  };

  const emitChange = () => {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (e) {
        logger.error("auth onChange listener failed: " + e.message);
      }
    }
  };

  const readStored = () => {
    const s = readJson(userPath);
    return s && s.token && s.user ? s : null;
  };

  const getSocket = () => {
    if (!socket) {
      socket = socketFactory();
      for (const cb of [...socketListeners]) {
        try {
          cb(socket);
        } catch (e) {
          logger.error("auth onSocket listener failed: " + e.message);
        }
      }
    }
    return socket;
  };

  const connectSocket = () => {
    const s = getSocket();
    if (!s.connected) s.connect();
    return s;
  };

  // Callers must pass an http client; every request here sets a 10 s timeout.
  const authHeaders = (token) => ({
    headers: { Authorization: "Bearer " + token },
    timeout: HTTP_TIMEOUT_MS,
  });

  const clearFiles = () => {
    removeFile(userPath);
    removeFile(cachePath);
  };

  const clearLocal = () => {
    clearFiles();
    if (socket && socket.connected) socket.disconnect();
  };

  const getSession = () => {
    const s = readStored();
    if (!s) return null;
    const { id, name, email, avatar } = s.user;
    return { token: s.token, user: { id, name, email, avatar } };
  };

  async function completeLogin({ token }) {
    const hwid = getHwid();
    await http.post(`${BASE_URL}/api/desktop/bind`, { hwid, app: "nomopro" }, authHeaders(token));
    const res = await http.get(`${BASE_URL}/api/user`, authHeaders(token));
    const stored = { user: res.data, token };
    writeJsonAtomic(userPath, stored);
    removeFile(cachePath); // never carry a previous account's kits over
    connectSocket().emit("login", stored);
    emitChange();
  }

  async function login() {
    const payload = await openLoginWindow();
    if (!payload || !payload.token) {
      throw Object.assign(new Error("Login cancelled"), { code: "cancelled" });
    }
    await completeLogin(payload);
    return getSession();
  }

  async function logout() {
    const stored = readStored();
    // Clear local state first: a slow or dead network must never block it.
    clearFiles();
    emitChange();
    if (!stored) return;
    try {
      const s = getSocket();
      if (s.connected) s.emit("logout", stored.token);
      s.disconnect();
    } catch (e) {
      logger.warn("Socket logout failed: " + e.message);
    }
    // Best effort, not awaited.
    Promise.resolve()
      .then(() => http.post(`${BASE_URL}/api/logout`, null, authHeaders(stored.token)))
      .catch((e) => logger.warn("Logout request failed, continuing: " + e.message));
  }

  const fromCache = () => {
    const c = readJson(cachePath);
    if (!c) return EMPTY_KITS();
    const kits = Array.isArray(c.kit_external_id) ? c.kit_external_id : [];
    let subs = false;
    if (c.access_until != null) {
      const until = new Date(c.access_until).getTime();
      subs = !Number.isNaN(until) && now().getTime() <= until + GRACE_MS;
    }
    return { is_active_subs: kits.length > 0 || subs, kit_external_id: kits };
  };

  async function getKits() {
    const stored = readStored();
    if (!stored) return EMPTY_KITS();
    let data;
    try {
      const res = await http.get(`${BASE_URL}/api/me/kits`, authHeaders(stored.token));
      data = res && res.data;
    } catch (e) {
      if (e && e.response && e.response.status === 401) {
        // Only if the token used for this request is still the current one.
        const cur = readStored();
        if (cur && cur.token === stored.token) {
          clearLocal();
          emitChange();
        }
        return EMPTY_KITS();
      }
      // No response (offline) or any other HTTP error: use the cache.
      return fromCache();
    }
    // A captive portal / proxy can answer 200 with HTML: don't trust it.
    if (!data || !Array.isArray(data.kit_external_id) || typeof data.is_active_subs !== "boolean") {
      return fromCache();
    }
    const { is_active_subs, kit_external_id, access_until } = data;
    try {
      writeJsonAtomic(cachePath, {
        kit_external_id,
        is_active_subs,
        access_until: access_until ?? null,
        fetched_at: now().toISOString(),
      });
    } catch (e) {
      logger.error("Failed to write kits cache: " + e.message);
    }
    return { is_active_subs, kit_external_id };
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  // cb(socket) runs once the socket exists (now if it already does), so the
  // one-device-rule handler can attach to the auth-owned socket.
  function onSocket(cb) {
    socketListeners.add(cb);
    if (socket) cb(socket);
    return () => socketListeners.delete(cb);
  }

  function start() {
    if (readStored()) connectSocket();
  }

  return { getSession, completeLogin, login, logout, getKits, onChange, onSocket, start };
}

module.exports = { createAuth };
