const fs = require("fs");
const os = require("os");
const path = require("path");

// arduino-cli.yaml harus ada di lokasi yang bisa ditulis. Install all-users /
// ACL korporat bisa membuat folder install read-only, dan arduino-cli 1.5.0
// dengan --config-file yang tak ada mengembalikan `{"config":{}}` (Preferences
// kosong, build gagal).
//
// Hanya FILE CONFIG yang dipindah — library/data tetap di C:
//   - library  : <install>/resources/app/src/link/tools/Arduino/libraries
//   - data/user: C:\NomokitData\arduino-data (lihat appdata.js)
// Urutan fallback menjaga path pendek (C) lebih dulu, AppData paling akhir.
//
// Fallback HARUS deterministik & sama di semua proses (main process yang
// menulis, link server yang membaca) — karena itu berbasis aturan path tetap,
// bukan app.getPath("userData").
const WINDOWS_DATA_ROOT = path.join("C:", "NomokitData", "arduino-data");

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.nomokit-write-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function appDataConfigFile() {
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "nomokit-desktop", "arduino-cli.yaml");
}

// Kandidat berurutan: install dir -> data root C: -> AppData.
function candidates(arduinoPath) {
  const list = [path.join(arduinoPath, "arduino-cli.yaml")];
  if (process.platform === "win32") {
    list.push(path.join(WINDOWS_DATA_ROOT, "arduino-cli.yaml"));
  }
  list.push(appDataConfigFile());
  return list;
}

/**
 * Resolve lokasi arduino-cli.yaml yang bisa ditulis (path pendek diutamakan).
 * @param {string} arduinoPath - folder `tools/Arduino` (tempat arduino-cli.exe).
 * @returns {string}
 */
function resolveArduinoConfigFile(arduinoPath) {
  const list = candidates(arduinoPath);
  for (const file of list) {
    if (canWrite(path.dirname(file))) return file;
  }
  return list[list.length - 1];
}

module.exports = { resolveArduinoConfigFile };
