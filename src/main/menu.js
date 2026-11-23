const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { Menu, dialog, shell } = require("electron");
const { execFile } = require("child_process");
const logger = require("./logger");
const { getAuth } = require("./auth-instance");

const { runArduinoCoreAction } = require("./arduino-updater");
const { showArduinoUpdateWindow } = require("./arduino-update-window");
const { getAppDataPath, getLocalLibJsonPath } = require("./appdata");

let _menuState = null;

function getArduinoDir(appRoot) {
  return path.join(appRoot, "src/link/tools/Arduino");
}

function getArduinoCli(appRoot) {
  const exe = process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli";
  return path.join(getArduinoDir(appRoot), exe);
}

function getArduinoConfig(appRoot) {
  return path.join(getArduinoDir(appRoot), "arduino-cli.yaml");
}

// `arduino-cli core list` used to run with execSync every time the menu was built, blocking the
// main process (~0.2 s on a fast Mac, much more on Windows) at startup and after login. Now the menu
// is built from the last known list at once and rebuilt when a background refresh finishes.
let coresCache = null; // null = not loaded yet (or invalidated)
let coresLoading = null;

function loadInstalledCores(appRoot) {
  if (!coresLoading) {
    coresLoading = new Promise((resolve) => {
      execFile(
        getArduinoCli(appRoot),
        ["core", "list", "--format", "json", "--config-file", getArduinoConfig(appRoot)],
        { cwd: getArduinoDir(appRoot), encoding: "utf8", timeout: 15000, windowsHide: true },
        (err, out) => {
          let list = [];
          if (!err) {
            try {
              list = JSON.parse(String(out).trim()).platforms || [];
            } catch {
              list = [];
            }
          }
          coresCache = list;
          coresLoading = null;
          resolve(list);
        },
      );
    });
  }
  return coresLoading;
}

function getInstalledCores() {
  return coresCache || [];
}

/**
 * Optional cores — user can install/uninstall via menu.
 * arduino:avr (Uno, Nano, Mega) is bundled with the installer, not listed here.
 */
function getAdditionalCores() {
  return [
    { id: "esp32:esp32", label: "ESP32", version: "2.0.16" },
    { id: "esp8266:esp8266", label: "ESP8266", version: "3.0.2" },
    { id: "arduino:mbed_nano", label: "Arduino Nano 33 BLE" },
    { id: "arduino:renesas_uno", label: "Arduino Uno R4" },
  ];
}

/**
 * Cores that ship bundled with the installer and should be excluded from
 * the "Install/Uninstall Board" submenus.
 */
function getBuiltInCores() {
  return ["arduino:avr"];
}

/**
 * Check if a core is built-in (bundled with installer).
 */
function isBuiltInCore(coreId) {
  return getBuiltInCores().includes(coreId);
}

function arduinoCoreAction(appRoot, action, coreId, version) {
  const emitter = new EventEmitter();
  emitter.on("complete", () => {
    coresCache = null; // installed cores changed: refresh
    if (_menuState) setMenu(_menuState);
  });
  emitter.on("error", () => {
    coresCache = null;
    if (_menuState) setMenu(_menuState);
  });
  showArduinoUpdateWindow({ emitter });
  runArduinoCoreAction({ appRoot, coreId, action, version, emitter });
}

async function showInstalledCores(appRoot) {
  coresCache = null;
  const cores = await loadInstalledCores(appRoot);
  const win = require("electron").BrowserWindow.getFocusedWindow();
  console.log("Installed cores:", cores);
  if (cores.length === 0) {
    dialog.showMessageBox(win, {
      type: "info",
      title: "Installed Boards",
      message: "No boards installed.",
    });
    return;
  }
  const list = cores.map((c) => `  - ${c.name ?? c.id}`).join("\n");
  dialog.showMessageBox(win, {
    type: "info",
    title: "Installed Boards",
    message: `Installed boards:\n${list}`,
  });
}

let _authWatching = false;

function setMenu({ win, appRoot, app }) {
  _menuState = { win, appRoot, app };
  const auth = getAuth();
  // Rebuild once per login/logout so "Masuk"/"Keluar" follows the session.
  if (!_authWatching) {
    _authWatching = true;
    auth.onChange(() => {
      if (_menuState) setMenu(_menuState);
    });
  }
  const loggedIn = !!auth.getSession();
  let localLib = [];
  let version = {};
  try {
    localLib = JSON.parse(fs.readFileSync(getLocalLibJsonPath(), "utf8"));
  } catch (e) {
    logger.warn("Failed to read localLib.json: " + e.message);
  }
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(appRoot, "src/version.json"), "utf8"),
    );
  } catch (e) {
    logger.warn("Failed to read version.json: " + e.message);
  }
  const libary = localLib.map((item, index) => ({
    label: `${index + 1}. ${item}`,
  }));

  const installedCores = getInstalledCores();
  if (coresCache === null) {
    loadInstalledCores(appRoot).then(() => {
      if (_menuState) setMenu(_menuState);
    });
  }
  const installedIds = installedCores.map((c) => c.id);

  // Install submenu: only optional cores (exclude built-in)
  const installSubmenu = getAdditionalCores()
    .filter((core) => !isBuiltInCore(core.id))
    .map((core) => ({
      label: `Install ${core.label}`,
      click: () => arduinoCoreAction(appRoot, "install", core.id, core.version),
    }));

  // Uninstall submenu: optional cores that are currently installed
  const uninstallItems = getAdditionalCores()
    .filter((core) => installedIds.includes(core.id) && !isBuiltInCore(core.id))
    .map((core) => ({
      label: `Uninstall ${core.label}`,
      click: () => arduinoCoreAction(appRoot, "uninstall", core.id),
    }));

  if (uninstallItems.length === 0) {
    uninstallItems.push({
      label: "No Board Installed",
      enabled: false,
    });
  }

  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetzoom" },
        { role: "zoomin" },
        { role: "zoomout" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    {
      label: "Tools",
      submenu: [
        {
          label: "Arduino Board",
          submenu: [
            {
              label: "Install Board",
              submenu: installSubmenu,
            },
            {
              label: "Uninstall Board",
              submenu: uninstallItems,
            },
            { type: "separator" },
            {
              label: "Check Installed Boards",
              click: () => showInstalledCores(appRoot),
            },
          ],
        },
      ],
    },

    {
      label: "Local Library",
      submenu: [
        {
          label: "Add .ZIP Library",
          click: async () => {
            const { dialog } = require("electron");
            const extract = require("extract-zip");
            const localDir = getAppDataPath("local");
            const librariesDir = path.join(
              appRoot,
              "src/link/tools/Arduino/libraries",
            );
            dialog
              .showOpenDialog({
                properties: ["openFile"],
                filters: [{ name: "Zip", extensions: ["zip"] }],
              })
              .then(async (res) => {
                if (!res.canceled) {
                  try {
                    await extract(res.filePaths[0], {
                      dir: localDir,
                    });
                    await extract(res.filePaths[0], {
                      dir: librariesDir,
                    });

                    const filesName = [];
                    fs.readdir(localDir, (err, files) => {
                      files.forEach(async (file) => {
                        if (!file.includes(".txt")) {
                          filesName.push(file + ".h");
                        }
                      });
                      fs.writeFileSync(
                        getLocalLibJsonPath(),
                        JSON.stringify(filesName),
                      );
                    });
                    dialog.showMessageBox({
                      type: "info",
                      title: "Success",
                      message: "Add libary success",
                    });
                    // Refresh menu
                    setMenu({ win, appRoot, app });
                  } catch (error) {
                    console.log(error);
                  }
                }
              });
          },
        },
        ...libary,
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Learn More",
          click: async () => {
            const { shell } = require("electron");
            await shell.openExternal("https://nomo-kit.com/");
          },
        },
        {
          label: "Check Update",
          click: async () => {
            const { syncGui, syncLink, syncLibrary } = require(
              path.join(appRoot, "src/main/sync"),
            );
            await syncGui(win, appRoot);
            await syncLink(win, appRoot);
            await syncLibrary(appRoot);
          },
        },
        { label: "Version GUI: " + version.gui, enabled: false },
        { label: "Version LINK: " + version.link, enabled: false },
        loggedIn
          ? {
              label: "Keluar",
              click: () => {
                getAuth().logout();
              },
            }
          : {
              label: "Masuk",
              click: async () => {
                try {
                  await getAuth().login();
                } catch (e) {
                  if (e && e.code === "network") {
                    dialog.showErrorBox(
                      "Masuk",
                      "Tidak dapat terhubung ke nomo-kit.com. Periksa koneksi internet lalu coba lagi.",
                    );
                  } else if (!e || e.code !== "cancelled") {
                    logger.warn("Login from menu failed: " + (e && e.message));
                  }
                }
              },
            },
        {
          label: "Exit",
          click: async () => {
            app.quit();
          },
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { setMenu };
