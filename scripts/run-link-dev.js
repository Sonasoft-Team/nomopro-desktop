// Link server standalone untuk dev frontend C++ (tanpa Electron).
//   node scripts/run-link-dev.js        (atau: npm run link:dev)
// Lalu di repo nomokit-cpp: npm run dev  -> buka http://localhost:5173
//
// Catatan: fitur yang butuh dialog OS (konfirmasi install, buka/simpan sketch
// ke folder) tidak aktif di mode ini — butuh runtime Electron.
const path = require("path");
const os = require("os");
const OpenBlockLink = require("../src/link/src");

const userDataPath = path.join(os.tmpdir(), "nomokit-link-dev");
const toolsPath = path.join(__dirname, "../src/link/tools");

const link = new OpenBlockLink(userDataPath, toolsPath);
link.listen();

console.log("link dev di ws://127.0.0.1:20111/openblock/cpp");
console.log("userData:", userDataPath);
console.log("Sekarang jalankan: cd nomokit-cpp && npm run dev  -> http://localhost:5173");
