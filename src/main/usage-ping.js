/**
 * Anonymous usage ping: once per launch, tell nomo-kit.com that this install was opened, so we can
 * count installs and active users without requiring a login (nomokit: POST /api/desktop/ping,
 * `php artisan desktop:stats`).
 *
 * Sent: a random install ID (created on first launch, kept in userData/install-id), the app and
 * GUI versions, and the OS platform/arch. Nothing about the user, their account, machine ID or
 * projects. Never throws and never blocks start-up.
 *
 * Skipped in unpackaged dev runs, and when NOMOKIT_NO_USAGE_PING=1 is set.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PING_URL = "https://nomo-kit.com/api/desktop/ping";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the install ID from <dir>/install-id, creating it if missing or invalid. */
function getInstallId(dir) {
  const file = path.join(dir, "install-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (UUID_RE.test(existing)) return existing;
  } catch (_) {
    // missing: create below
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, id + "\n");
  } catch (_) {
    // can't persist: still send this launch, it just won't be recognised next time
  }
  return id;
}

/** Read "gui" from src/version.json, or null. */
function readGuiVersion(appRoot) {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(appRoot, "src/version.json"), "utf8"),
    );
    return typeof v.gui === "string" ? v.gui : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.userDataDir  where install-id lives (app.getPath("userData"))
 * @param {string} opts.appRoot      app directory (for src/version.json)
 * @param {string} opts.appVersion   app.getVersion()
 * @param {boolean} opts.packaged    app.isPackaged
 * @param {(url: string, body: object) => Promise<any>} [opts.post]  injectable for tests
 * @param {object} [opts.logger]
 * @returns {Promise<boolean>} true if the ping was accepted
 */
async function sendUsagePing(opts) {
  const { userDataDir, appRoot, appVersion, packaged, logger } = opts;
  if (!packaged || process.env.NOMOKIT_NO_USAGE_PING === "1") return false;
  try {
    const post =
      opts.post ||
      ((url, body) => require("axios").post(url, body, { timeout: 10000 }));
    await post(PING_URL, {
      install_id: getInstallId(userDataDir),
      app: appVersion,
      gui: readGuiVersion(appRoot),
      platform: process.platform,
      arch: process.arch,
    });
    return true;
  } catch (e) {
    if (logger) logger.warn("usage ping failed: " + (e && e.message));
    return false;
  }
}

module.exports = { sendUsagePing, getInstallId, PING_URL };
