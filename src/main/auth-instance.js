const path = require("path");
const axios = require("axios");
const { io } = require("socket.io-client");
const { createAuth } = require("./auth");
const { openLoginWindow, clearLoginSession } = require("./auth-window");
const logger = require("./logger");

let instance = null;
let parentWindow = null;

function setAuthParentWindow(win) {
  parentWindow = win;
}

function getAuth() {
  if (!instance) {
    instance = createAuth({
      appRoot: path.join(__dirname, "..", ".."),
      http: axios,
      getHwid: require("node-machine-id").machineIdSync,
      socketFactory: () =>
        io("http://15.235.140.95:2023", { reconnection: true, timeout: 10000 }),
      openLoginWindow: () => openLoginWindow(parentWindow),
      onLogout: clearLoginSession,
      logger,
    });
  }
  return instance;
}

module.exports = { getAuth, setAuthParentWindow };
