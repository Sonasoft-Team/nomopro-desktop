const fs = require("fs");
const path = require("path");

const BASE_URL = "https://nomo-kit.com";
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
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
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
    if (!socket) socket = socketFactory();
    return socket;
  };

  const connectSocket = () => {
    const s = getSocket();
    if (!s.connected) s.connect();
    return s;
  };

  const authHeaders = (token) => ({ headers: { Authorization: "Bearer " + token } });

  const clearLocal = () => {
    removeFile(userPath);
    removeFile(cachePath);
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
    if (stored) {
      try {
        await http.post(`${BASE_URL}/api/logout`, null, authHeaders(stored.token));
      } catch (e) {
        logger.warn("Logout request failed, continuing: " + e.message);
      }
      try {
        const s = getSocket();
        if (s.connected) s.emit("logout", stored.token);
        s.disconnect();
      } catch (e) {
        logger.warn("Socket logout failed: " + e.message);
      }
    }
    clearLocal();
    emitChange();
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
    try {
      const res = await http.get(`${BASE_URL}/api/me/kits`, authHeaders(stored.token));
      const { is_active_subs, kit_external_id, access_until } = res.data;
      writeJsonAtomic(cachePath, {
        kit_external_id,
        is_active_subs,
        access_until: access_until ?? null,
        fetched_at: now().toISOString(),
      });
      return { is_active_subs, kit_external_id };
    } catch (e) {
      if (e && e.response && e.response.status === 401) {
        clearLocal();
        emitChange();
        return EMPTY_KITS();
      }
      // No response (offline) or any other HTTP error: use the cache.
      return fromCache();
    }
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function start() {
    if (readStored()) connectSocket();
  }

  return { getSession, completeLogin, login, logout, getKits, onChange, start };
}

module.exports = { createAuth };
