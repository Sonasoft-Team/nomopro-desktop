const path = require("path");
const OpenBlockLink = require("../link/src");
const logger = require("./logger");
const { getAppDataPath } = require("./appdata");

function startLink({ win, userDataPath, toolsPath } = {}) {
  const resolvedToolsPath = toolsPath || path.join(__dirname, "../link/tools");
  const resolvedUserDataPath = userDataPath || getAppDataPath("link-data");

  // Arduino tools update dihapus dari auto-startup.
  // User bisa trigger manual via menu: Tools > Arduino Board > Install/Uninstall Board.

  const link = new OpenBlockLink(resolvedUserDataPath, resolvedToolsPath);
  // Bridge link-server lifecycle to the file log (the link modules use
  // console.*, which never reaches nomopro.log).
  link.on("ready", () =>
    logger.info(`Link server ready on 127.0.0.1:${link._port}`),
  );
  link.on("port-in-use", () =>
    logger.warn("Link server port in use; retrying"),
  );
  link.on("error", (info) => logger.error("Link server error: " + info));
  link.on("connection", (c) =>
    logger.info(`Link connection ${c.pathname} origin=${c.origin}`),
  );
  link.listen();
  logger.info(
    `Link server started (module) toolsPath=${resolvedToolsPath} userDataPath=${resolvedUserDataPath}`,
  );
  return link;
}

module.exports = { startLink };
