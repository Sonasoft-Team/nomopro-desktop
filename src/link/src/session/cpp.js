const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { SerialPort } = require("serialport");
const portLock = require("../lib/port-lock");
const Session = require("./session");
const Arduino = require("../upload/arduino");
const usbId = require("../lib/usb-id");
const { resolveArduinoConfigFile } = require("../lib/arduino-config-path");
const traceLog = require("../lib/trace-log");

// portLock memperbolehkan RE-ACQUIRE oleh owner yang sama
// (port-lock.js:28 — `existing.owner !== owner` baru menolak).
// Jadi SATU owner untuk upload + monitor = tidak saling kunci. Owner WAJIB
// dipisah per operasi.
// Dinaikkan saat kontrak method berubah, agar frontend bisa mendeteksi
// backend yang terlalu lama (atau sebaliknya).
const CPP_API_VERSION = 1;

const LOCK_OWNER_UPLOAD = "cpp-session:upload";
const LOCK_OWNER_MONITOR = "cpp-session:monitor";

// Origin browser tak bisa dipalsukan (WebSocket tidak bisa set header Origin).
// null = iframe file:// pada build prod.
// undefined = klien non-browser (wscat/curl) — diizinkan setelah pertimbangan
// sadar: proses lokal sudah punya akses FS lebih besar dari ini. Ini TIDAK
// melindungi dari peer di LAN (server masih bind 0.0.0.0) — lihat Tahap 2.
const ALLOWED_ORIGINS = new Set([
  "null", // iframe file:// (spec)
  "file://", // Chromium kadang kirim ini untuk dokumen file://
  "http://127.0.0.1:8601",
  "http://localhost:8601",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const SKETCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const SKETCH_FILE_EXT = [".ino", ".h", ".hpp", ".cpp", ".c", ".cc", ".S"];

const CLI_TIMEOUT_MS = 30000;
const CLI_INSTALL_TIMEOUT_MS = 30 * 60 * 1000; // core/lib install: download besar
// Commands yang menyentuh index (download/parse) bisa >30s, terutama saat index
// baru ditambah belum ada lokal -> arduino-cli mengunduh dulu. library_index
// ~58MB. Default 30s membuat ini "arduino-cli timeout" walau jaringan normal.
const CLI_INDEX_TIMEOUT_MS = 5 * 60 * 1000;

class CppSession extends Session {
  constructor(socket, userDataPath, toolsPath, request) {
    super(socket);

    this.userDataPath = userDataPath;
    this.toolsPath = toolsPath;
    this._type = "cpp";
    this._sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this._arduinoPath = path.join(toolsPath, "Arduino");
    this._cliPath = path.join(
      this._arduinoPath,
      process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli",
    );
    this._configFile = resolveArduinoConfigFile(this._arduinoPath);
    traceLog.trace(
      "config",
      `file=${this._configFile} exists=${fs.existsSync(this._configFile)}`,
    );
    this._logCliVersion();
    this._tool = null;
    this._monitor = null;
    this._monitorPort = null;
    this._monitorClosing = false;
    this._installChild = null;

    // Cek origin PALING AKHIR, setelah semua field siap. `super()` sudah
    // memasang listener 'message'; kalau close() belum tuntas, pesan berikutnya
    // bisa menyentuh field yang belum di-assign.
    const origin = request && request.headers && request.headers.origin;
    if (!this._originAllowed(origin)) {
      traceLog.trace("ws", `cpp rejected connection origin="${origin}"`);
      socket.close(1008, "origin not allowed");
      return;
    }
    traceLog.trace("ws", `cpp connection accepted origin="${origin}"`);
  }

  _originAllowed(origin) {
    // Non-browser (tak ada Origin): diizinkan — server bind 127.0.0.1 (G5).
    if (origin === undefined || origin === null || origin === "") return true;
    // Dokumen lokal Electron: spec "null", Chromium bisa kirim "file://..." .
    if (origin === "null" || String(origin).startsWith("file:")) return true;
    return ALLOWED_ORIGINS.has(origin);
  }

  dispose() {
    // Socket tutup saat monitor hidup -> port tetap terkunci. Tutup + lepas lock.
    this._monitorClosing = true;
    if (this._monitor) {
      try {
        this._monitor.close(() => {});
      } catch (_) {}
      this._monitor = null;
    }
    if (this._monitorPort) {
      portLock.release(this._monitorPort, LOCK_OWNER_MONITOR);
      this._monitorPort = null;
    }
    super.dispose();
  }

  // ---- arduino-cli plumbing ----

  _runCli(args, timeout = CLI_TIMEOUT_MS) {
    const started = Date.now();
    const label = args.slice(0, 2).join(" ");
    return new Promise((resolve, reject) => {
      const child = spawn(this._cliPath, args, { cwd: this._arduinoPath });
      let out = "";
      let err = "";
      child.stdout.on("data", (b) => (out += b.toString()));
      child.stderr.on("data", (b) => (err += b.toString()));
      const timer = setTimeout(() => {
        child.kill();
        traceLog.trace("cli", `${label} TIMEOUT after ${timeout}ms`);
        reject(new Error(`arduino-cli timeout after ${timeout}ms`));
      }, timeout);
      child.on("error", (e) => {
        clearTimeout(timer);
        traceLog.trace("cli", `${label} SPAWN-ERROR: ${e.message}`);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        if (code === 0) {
          traceLog.trace("cli", `${label} exit=0 ${ms}ms`);
          return resolve(out);
        }
        traceLog.trace(
          "cli",
          `${label} exit=${code} ${ms}ms err=${err.trim().slice(-300)}`,
        );
        reject(new Error(err.trim() || `arduino-cli exited ${code}`));
      });
    });
  }

  // Catat versi arduino-cli sekali per session — mismatch versi CLI = sumber bug.
  _logCliVersion() {
    this._runCli(this._cli(["version"]), 10000).then(
      (out) => traceLog.trace("cli", `version: ${String(out).trim().slice(0, 80)}`),
      (e) => traceLog.trace("cli", `version FAILED: ${e.message}`),
    );
  }

  async _cliJson(args, timeout) {
    return JSON.parse(await this._runCli(args, timeout));
  }

  // core install bisa download ratusan MB (>30s) dan UI butuh progres.
  // _runCli mem-buffer output sampai exit — tidak cocok. Versi streaming ini
  // mempush tiap chunk sebagai event `operationStdout` dan memakai timeout
  // panjang (CLI_INSTALL_TIMEOUT_MS).
  _runCliStream(args, timeout = CLI_INSTALL_TIMEOUT_MS) {
    // Gerbang G4 — single-flight. Install/uninstall/index bisa saling
    // menabrak kalau jalan bersamaan (menulis data dir yang sama).
    if (this._installChild) {
      return Promise.reject(new Error("another operation is running"));
    }
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const label = args.slice(0, 2).join(" ");
      const child = spawn(this._cliPath, args, { cwd: this._arduinoPath });
      this._installChild = child;
      traceLog.trace("cli", `${label} START (stream)`);
      let err = "";
      const push = (s) =>
        this.sendRemoteRequest("operationStdout", { message: s });
      child.stdout.on("data", (b) => push(b.toString()));
      child.stderr.on("data", (b) => {
        err += b.toString();
        push(b.toString());
      });
      const done = () => {
        if (this._installChild === child) this._installChild = null;
      };
      const timer = setTimeout(() => {
        child.kill();
        done();
        traceLog.trace("cli", `${label} TIMEOUT after ${timeout}ms`);
        reject(new Error(`arduino-cli timeout after ${timeout}ms`));
      }, timeout);
      child.on("error", (e) => {
        clearTimeout(timer);
        done();
        traceLog.trace("cli", `${label} SPAWN-ERROR: ${e.message}`);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        done();
        const ms = Date.now() - started;
        traceLog.trace("cli", `${label} exit=${code} ${ms}ms`);
        if (code === 0) return resolve({ ok: true });
        reject(new Error(err.trim() || `arduino-cli exited ${code}`));
      });
    });
  }

  // Semua subcommand butuh --config-file agar path data dir konsisten.
  _cli(args, timeout) {
    return [...args, "--config-file", this._configFile];
  }

  _newArduino(fqbn, port) {
    // userDataPath di-scope per session -> build dir terisolasi tanpa
    // mengubah arduino.js.
    const scoped = path.join(this.userDataPath, "cpp", this._sessionId);
    return new Arduino(
      port || "",
      { type: "arduino", fqbn },
      scoped,
      this.toolsPath,
      this.sendstd.bind(this),
    );
  }

  sendstd(message) {
    if (this._socket) {
      this.sendRemoteRequest("uploadStdout", { message });
    }
  }

  // ---- dispatch ----

  async didReceiveCall(method, params, completion) {
    try {
      completion(await this._handle(method, params || {}), null);
    } catch (err) {
      completion(null, { message: err.message });
    }
  }

  async _handle(method, params) {
    switch (method) {
      case "pingMe":
        this.sendRemoteRequest("ping", null);
        return "willPing";

      case "cppVersion":
        return { api: CPP_API_VERSION, name: "nomokit-cpp" };

      case "discoverPorts":
        return this._discoverPorts();

      // CLI membungkus hasil dalam key (`boards`), key itu memuat platform
      // penuh berulang -> JSON mentah 5,6 MB. Hanya ambil 3 field flat.
      case "boardListAll": {
        const j = await this._cliJson(
          this._cli(["board", "listall", "--format", "json"]),
          CLI_INDEX_TIMEOUT_MS,
        );
        const seen = new Set();
        return (j.boards || [])
          .filter((b) => !seen.has(b.fqbn) && seen.add(b.fqbn))
          .map((b) => ({
            fqbn: b.fqbn,
            name: b.name,
            platform:
              (b.platform && b.platform.metadata && b.platform.metadata.id) ||
              "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }

      // `board list` -> { detected_ports: [{ port: { address, protocol, vid, pid, ... } }] }
      case "boardList": {
        const j = await this._cliJson(
          this._cli(["board", "list", "--format", "json"]),
          CLI_INDEX_TIMEOUT_MS,
        );
        return (j.detected_ports || []).map((e) => {
          const p = e.port || {};
          const props = p.properties || {};
          return {
            address: p.address,
            protocol: p.protocol,
            label: p.label,
            vid: props.vid,
            pid: props.pid,
            serialNumber: props.serialNumber,
            // CLI hanya mengisi ini untuk board yang dikenali. Dipakai
            // frontend sebagai hint FQBN; kosong = user pilih manual.
            matchingBoards: (e.matching_boards || []).map((b) => ({
              name: b.name,
              fqbn: b.fqbn,
            })),
          };
        });
      }

      case "boardDetails": {
        const args = ["board", "details", "-b", params.fqbn, "--format", "json"];
        if (params.boardOptions) {
          args.push("--board-options", params.boardOptions);
        }
        return this._cliJson(this._cli(args), CLI_INDEX_TIMEOUT_MS);
      }

      // `core list` -> { platforms: [{ id, releases: {ver:...}, installed_version, latest_version }] }
      // Pangkas `releases`; hasilkan flag outdated langsung (tak perlu `core outdated`).
      case "coreList":
        return this._coreList();

      // Fase 4 — pengelola
      // `core search` -> { platforms: [{ id, maintainer, website, releases, installed_version, latest_version }] }
      case "coreSearch": {
        const args = ["core", "search"];
        if (params.query) args.push(params.query);
        args.push("--format", "json");
        const j = await this._cliJson(this._cli(args), CLI_INDEX_TIMEOUT_MS);
        return (j.platforms || []).map((p) => {
          const latest = (p.releases && p.releases[p.latest_version]) || {};
          return {
            id: p.id,
            name: latest.name || p.id,
            author: p.maintainer || "",
            homepage: p.website || "",
            latestVersion: p.latest_version || null,
            installedVersion: p.installed_version || null,
            versions: this._sortVersions(Object.keys(p.releases || {})),
            installed: Boolean(p.installed_version),
            outdated: Boolean(
              p.installed_version &&
                p.latest_version &&
                p.installed_version !== p.latest_version,
            ),
          };
        });
      }

      case "coreOutdated": {
        const list = await this._coreList();
        return list
          .filter((c) => c.outdated)
          .map((c) => ({
            id: c.id,
            installed: c.installedVersion,
            latest: c.latestVersion,
          }));
      }

      case "coreUninstall": {
        await this._requireConfirm("Remove core", params.core);
        return this._runCliStream(
          this._cli(["core", "uninstall", params.core]),
        );
      }

      case "coreUpdateIndex":
        return this._runCliStream(this._cli(["core", "update-index"]));

      // `lib search --omit-releases-details` -> { libraries: [{ name, latest:{author,sentence,category,architectures,version}, available_versions }] }
      case "libSearch": {
        const args = ["lib", "search"];
        if (params.query) args.push(params.query);
        args.push("--omit-releases-details", "--format", "json");
        const j = await this._cliJson(this._cli(args), CLI_INDEX_TIMEOUT_MS);
        const installed = new Set((await this._libList()).map((l) => l.name));
        return (j.libraries || []).map((l) => {
          const x = l.latest || {};
          return {
            name: l.name,
            latestVersion: x.version || null,
            author: x.author || "",
            sentence: x.sentence || "",
            category: x.category || "",
            architectures: x.architectures || [],
            versions: this._sortVersions(l.available_versions || []),
            website: x.website || (x.resources && x.resources.url) || "",
            installed: installed.has(l.name),
          };
        });
      }

      // `lib list` -> { installed_libraries: [{ library: {...} }] }
      case "libList":
        return this._libList();

      case "libOutdated": {
        const j = await this._cliJson(
          this._cli(["lib", "list", "--updatable", "--format", "json"]),
          CLI_INDEX_TIMEOUT_MS,
        );
        return (j.installed_libraries || []).map((e) => {
          const l = e.library || {};
          return {
            name: l.name,
            installed: l.version,
            latest: l.available_version || l.version,
          };
        });
      }

      case "libDeps": {
        const out = await this._runCli(
          this._cli(["lib", "deps", params.name]),
          CLI_INDEX_TIMEOUT_MS,
        );
        return this._parseDeps(out);
      }

      case "libApi":
        return this._libApi(params);

      case "libFile":
        return this._libFile(params);

      case "libInstallZip":
        return this._libInstallZip();

      case "libInstallGit":
        return this._libInstallGit(params);

      case "openLibDir":
        return this._openLibDir();

      case "openExternal":
        return this._openExternal(params);

      // Fase 5 — format C++ via clang-format (WASM, tanpa biner eksternal).
      case "formatCode":
        return this._formatCode(params);

      case "verify":
        return this._verify(params);

      case "exportBinary":
        return this._exportBinary(params);

      case "upload":
        return this._upload(params);

      case "abortUpload":
        if (this._tool) this._tool.abortUpload();
        return { aborted: true };

      // Fase 4 — install butuh streaming + timeout panjang
      case "coreInstall": {
        const spec = params.version
          ? `${params.core}@${params.version}`
          : params.core;
        await this._requireConfirm("Install core", spec);
        return this._runCliStream(this._cli(["core", "install", spec]));
      }

      case "libInstall": {
        const spec = params.version
          ? `${params.name}@${params.version}`
          : params.name;
        await this._requireConfirm("Install library", spec);
        return this._runCliStream(this._cli(["lib", "install", spec]));
      }

      case "libUninstall": {
        await this._requireConfirm("Remove library", params.name);
        return this._runCliStream(
          this._cli(["lib", "uninstall", params.name]),
        );
      }

      case "cacheClean":
        return this._runCliStream(this._cli(["cache", "clean"]));

      // Fase 5 — preferensi. `config dump` membungkus hasil dalam `.config`.
      // Config KOSONG ({"config":{}}) = file config hilang/rusak — JANGAN
      // kembalikan sunyi `{directories:{}}`, user hanya melihat Preferences
      // kosong dan tak ada yang tercatat.
      case "configDump": {
        const j = await this._cliJson(
          this._cli(["config", "dump", "--format", "json"]),
        );
        const cfg = j.config || {};
        if (!cfg.directories || Object.keys(cfg.directories).length === 0) {
          throw new Error(
            `arduino-cli config kosong; file config tidak ditemukan/rusak: ${this._configFile}`,
          );
        }
        traceLog.trace(
          "config",
          `dump data=${cfg.directories.data} user=${cfg.directories.user} ` +
            `urls=${((cfg.board_manager || {}).additional_urls || []).length}`,
        );
        return {
          board_manager: cfg.board_manager || { additional_urls: [] },
          directories: cfg.directories || {},
          raw: cfg,
        };
      }

      case "configSet": {
        const key = String(params.key || "").trim();
        if (!/^[A-Za-z0-9_.]+$/.test(key)) {
          throw new Error("invalid setting key");
        }
        return this._runCliStream(
          this._cli(["config", "set", key, String(params.value ?? "")]),
        );
      }

      case "configAddUrl": {
        const url = this._assertHttpUrl(params.url);
        await this._requireConfirm("Add board manager URL", url);
        await this._runCliStream(
          this._cli(["config", "add", "board_manager.additional_urls", url]),
        );
        // Unduh index yang baru sekarang (streamed -> progres terlihat) supaya
        // search berikutnya tak memicu unduhan senyap yang bisa timeout.
        // Kalau gagal, URL tetap tersimpan; laporkan sebagai flag, bukan error.
        try {
          await this._runCliStream(this._cli(["core", "update-index"]));
          return { ok: true, indexUpdated: true };
        } catch (e) {
          traceLog.trace("config", `update-index after add failed: ${e.message}`);
          return { ok: true, indexUpdated: false, indexError: e.message };
        }
      }

      case "configRemoveUrl": {
        const url = this._assertHttpUrl(params.url);
        return this._runCliStream(
          this._cli([
            "config",
            "remove",
            "board_manager.additional_urls",
            url,
          ]),
        );
      }

      // Fase 5 — sketch manager (penyimpanan dalam userData, bukan dialog OS)
      case "sketchList":
        return this._sketchList();

      case "sketchSave": {
        const p = this._sketchPath(params.name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(
          p,
          JSON.stringify(
            { name: params.name, files: params.files || {}, savedAt: Date.now() },
            null,
            2,
          ),
          "utf8",
        );
        return { ok: true, savedAt: Date.now() };
      }

      case "sketchLoad": {
        const p = this._sketchPath(params.name);
        if (!fs.existsSync(p)) throw new Error("sketch not found");
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        return { name: j.name, files: j.files || {} };
      }

      case "sketchDelete": {
        const p = this._sketchPath(params.name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return { ok: true };
      }

      // Fase 5 — sketch di disk via dialog OS (hanya saat link server jalan
      // di proses Electron main).
      case "sketchOpenDisk":
        return this._sketchOpenDisk();

      case "sketchSaveDisk":
        return this._sketchSaveDisk(params);

      case "sketchExportZip":
        return this._sketchExportZip(params);

      case "sketchImportZip":
        return this._sketchImportZip();

      // Fase 5 — serial monitor
      case "monitorOpen":
        return this._monitorOpen(params);

      case "monitorWrite":
        return this._monitorWrite(params);

      case "monitorClose":
        return this._monitorClose();

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  async _discoverPorts() {
    const list = await SerialPort.list();
    return list.map((d) => {
      const vid = String(d.vendorId || "").toUpperCase();
      const pid = String(d.productId || "").toUpperCase();
      const name = usbId[`USB\\VID_${vid}&PID_${pid}`] || "Unknown device";
      return {
        peripheralId: d.path,
        name: `${name} (${d.path})`,
        vendorId: vid || null,
        productId: pid || null,
        serialNumber: d.serialNumber || null,
        manufacturer: d.manufacturer || null,
      };
    });
  }

  _sketchesDir() {
    return path.join(this.userDataPath, "cpp", "sketches");
  }

  _sketchPath(name) {
    const safe = String(name || "").trim();
    if (!SKETCH_NAME_RE.test(safe)) {
      throw new Error("invalid sketch name");
    }
    return path.join(this._sketchesDir(), `${safe}.json`);
  }

  // ---- dialog OS (hanya saat di proses Electron main) ----

  _electronDialog() {
    try {
      return require("electron").dialog || null;
    } catch (_) {
      return null;
    }
  }

  _electronShell() {
    try {
      return require("electron").shell || null;
    } catch (_) {
      return null;
    }
  }

  _electronWindow() {
    try {
      const { BrowserWindow } = require("electron");
      return (BrowserWindow && BrowserWindow.getFocusedWindow()) || null;
    } catch (_) {
      return null;
    }
  }

  // Gerbang G1 — konfirmasi wajib sebelum tindakan yang mengunduh/menulis.
  // Dialog native main process; frontend tak bisa melewatinya.
  async _requireConfirm(label, target) {
    const dialog = this._electronDialog();
    if (!dialog || typeof dialog.showMessageBox !== "function") {
      throw new Error("confirmation is only available in the desktop app");
    }
    const win = this._electronWindow();
    const opts = {
      type: "warning",
      buttons: ["Continue", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Confirm",
      message: `${label}: ${target}`,
      detail:
        "This downloads/writes to the Arduino data directory and cannot be undone.",
    };
    const res = await Promise.race([
      win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts),
      new Promise((r) => setTimeout(() => r({ response: 1 }), 60000)),
    ]);
    if (res.response !== 0) throw new Error("cancelled by user");
  }

  _showOpenDialog(opts) {
    const dialog = this._electronDialog();
    if (!dialog) {
      throw new Error("OS dialog is only available in the desktop app");
    }
    const win = this._electronWindow();
    return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
  }

  _showSaveDialog(opts) {
    const dialog = this._electronDialog();
    if (!dialog || typeof dialog.showSaveDialog !== "function") {
      throw new Error("OS dialog is only available in the desktop app");
    }
    const win = this._electronWindow();
    return win
      ? dialog.showSaveDialog(win, opts)
      : dialog.showSaveDialog(opts);
  }

  async _sketchOpenDisk() {
    const res = await this._showOpenDialog({
      title: "Open sketch folder",
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const dir = res.filePaths[0];
    const names = fs.readdirSync(dir).filter((f) => {
      const full = path.join(dir, f);
      return (
        fs.statSync(full).isFile() &&
        SKETCH_FILE_EXT.includes(path.extname(f))
      );
    });
    const folderName = path.basename(dir);
    const mainName =
      names.find(
        (n) => n.toLowerCase() === `${folderName}.ino`.toLowerCase(),
      ) || names.find((n) => n.toLowerCase().endsWith(".ino"));
    const files = {};
    for (const n of names) {
      const content = fs.readFileSync(path.join(dir, n), "utf8");
      if (mainName && n === mainName) files["code.ino"] = content;
      else files[path.basename(n)] = content;
    }
    if (!mainName) files["code.ino"] = "";
    return { name: folderName, files };
  }

  async _sketchSaveDisk({ name, files }) {
    const safe = String(name || "").trim();
    if (!SKETCH_NAME_RE.test(safe)) throw new Error("invalid sketch name");
    const res = await this._showOpenDialog({
      title: "Choose a location to save the sketch",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const target = path.join(res.filePaths[0], safe);
    fs.mkdirSync(target, { recursive: true });
    for (const key of Object.keys(files || {})) {
      const base = path.basename(key);
      if (base !== key) continue; // tolak path traversal
      // code.ino -> <nama>.ino (syarat arduino-cli: nama .ino = nama folder).
      const outName = base === "code.ino" ? `${safe}.ino` : base;
      fs.writeFileSync(path.join(target, outName), files[key], "utf8");
    }
    return { ok: true, dir: target };
  }

  // Export ke .zip (via `arduino-cli sketch archive`) dengan dialog Save.
  async _sketchExportZip({ name, files }) {
    const safe = String(name || "").trim();
    if (!SKETCH_NAME_RE.test(safe)) throw new Error("invalid sketch name");
    const save = await this._showSaveDialog({
      title: "Export sketch as .zip",
      defaultPath: `${safe}.zip`,
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (save.canceled || !save.filePath) return { canceled: true };

    const tmp = path.join(this.userDataPath, "cpp", "_export", safe);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const key of Object.keys(files || {})) {
      const base = path.basename(key);
      if (base !== key) continue;
      const outName = base === "code.ino" ? `${safe}.ino` : base;
      fs.writeFileSync(path.join(tmp, outName), files[key], "utf8");
    }
    await this._runCli(
      this._cli(["sketch", "archive", tmp, save.filePath, "-f"]),
      CLI_TIMEOUT_MS,
    );
    return { ok: true, path: save.filePath };
  }

  // Import dari .zip (adm-zip). Hanya ambil basename -> aman dari zip-slip.
  async _sketchImportZip() {
    const open = await this._showOpenDialog({
      title: "Import sketch (.zip)",
      properties: ["openFile"],
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (open.canceled || !open.filePaths[0]) return { canceled: true };
    const zipPath = open.filePaths[0];
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    const inos = entries.filter((e) => /\.ino$/i.test(e.entryName));
    const folderName = path.basename(zipPath).replace(/\.zip$/i, "");
    const main =
      inos.find(
        (e) =>
          path.basename(e.entryName).toLowerCase() ===
          `${folderName}.ino`.toLowerCase(),
      ) || inos[0];
    const files = {};
    for (const e of entries) {
      const base = path.basename(e.entryName);
      if (!SKETCH_FILE_EXT.includes(path.extname(base))) continue;
      const text = e.getData().toString("utf8");
      if (main && e === main) files["code.ino"] = text;
      else files[base] = text;
    }
    if (!files["code.ino"]) files["code.ino"] = "";
    return { name: folderName, files };
  }

  _sketchList() {
    const dir = this._sketchesDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = path.join(dir, f);
        let fileCount = 0;
        try {
          fileCount = Object.keys(JSON.parse(fs.readFileSync(p, "utf8")).files || {})
            .length;
        } catch (_) {}
        return {
          name: f.slice(0, -5),
          savedAt: fs.statSync(p).mtimeMs,
          fileCount,
        };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async _coreList() {
    const j = await this._cliJson(
      this._cli(["core", "list", "--format", "json"]),
      CLI_INDEX_TIMEOUT_MS,
    );
    return (j.platforms || []).map((p) => ({
      id: p.id,
      name: p.name,
      installedVersion: p.installed_version || null,
      latestVersion: p.latest_version || null,
      outdated: Boolean(
        p.installed_version &&
          p.latest_version &&
          p.installed_version !== p.latest_version,
      ),
    }));
  }

  // `lib list --all` -> { installed_libraries: [{ library: {...} }] }
  // `--all` ikut sertakan lib bawaan platform; tandai lewat `builtin`.
  async _libList() {
    const j = await this._cliJson(
      this._cli(["lib", "list", "--all", "--format", "json"]),
      CLI_INDEX_TIMEOUT_MS,
    );
    const list = (j.installed_libraries || []).map((e) => {
      const l = e.library || {};
      return {
        name: l.name,
        version: l.version || null,
        author: l.author || "",
        sentence: l.sentence || "",
        category: l.category || "",
        architectures: l.architectures || [],
        includes: l.provides_includes || [],
        website: l.website || "",
        builtin: Boolean(l.container_platform),
        location: l.location || "",
        installDir: l.install_dir || l.source_dir || "",
      };
    });
    // Dedupe nama: library yang sama bisa muncul dari beberapa core/platform
    // (mis. EEPROM/SPI/Wire ada di AVR dan ESP32). Utamakan yang user-install
    // (bukan builtin). Tanpa ini UI keyed-each bisa crash (duplicate key).
    const all = list.concat(this._bundledLibraries(list));
    all.sort((a, b) => (a.builtin ? 1 : 0) - (b.builtin ? 1 : 0));
    const seen = new Set();
    const out = [];
    for (const l of all) {
      const key = String(l.name || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    return out;
  }

  // Lib yang dibundel untuk mode block (tools/Arduino/libraries) tak muncul di
  // `lib list`, padahal IKUT ke include path build (flag --libraries). Tampilkan
  // sebagai built-in supaya bisa ditemukan di Library Manager.
  _bundledLibraries(existing) {
    const dir = path.join(this._arduinoPath, "libraries");
    if (!fs.existsSync(dir)) return [];
    const seen = new Set(existing.map((l) => String(l.name).toLowerCase()));
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch (_) {
        continue;
      }
      if (!isDir) continue;
      const props = this._readLibraryProperties(path.join(full, "library.properties"));
      const libName = props.name || name;
      if (seen.has(libName.toLowerCase())) continue;
      seen.add(libName.toLowerCase());
      out.push({
        name: libName,
        version: props.version || null,
        author: props.author || "",
        sentence: props.sentence || "",
        category: props.category || "",
        website: props.url || "",
        architectures: props.architectures
          ? props.architectures.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        builtin: true,
        bundled: true,
        location: "bundled",
        installDir: full,
      });
    }
    return out;
  }

  _readLibraryProperties(file) {
    const out = {};
    try {
      if (!fs.existsSync(file)) return out;
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const i = line.indexOf("=");
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    } catch (_) {}
    return out;
  }

  // Urut versi terbaru dulu. Banding numerik per segmen; prerelease dianggap
  // lebih tua dari rilis tanpa suffix.
  _sortVersions(list) {
    const key = (v) =>
      String(v)
        .split(/[.\-+]/)
        .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    return [...list].sort((a, b) => {
      const A = key(a);
      const B = key(b);
      const n = Math.max(A.length, B.length);
      for (let i = 0; i < n; i++) {
        const x = A[i] === undefined ? 0 : A[i];
        const y = B[i] === undefined ? 0 : B[i];
        if (x === y) continue;
        if (typeof x === "number" && typeof y === "number") return y - x;
        return String(y).localeCompare(String(x));
      }
      return 0;
    });
  }

  // Ekstrak simbol API library dari header (heuristik regex, bukan parser C++).
  async _libApi({ name }) {
    const wanted = String(name || "");
    const lib = (await this._libList()).find((l) => l.name === wanted);
    const dir =
      (lib && lib.installDir) ||
      path.join(this._arduinoPath, "libraries", wanted);
    if (!dir || !fs.existsSync(dir)) return [];

    const out = new Map();
    const add = (label, type) => {
      if (label && label.length > 1 && !out.has(label)) out.set(label, type);
    };
    const parseHeader = (text) => {
      for (const m of text.matchAll(/#\s*define\s+([A-Za-z_]\w*)/g)) {
        add(m[1], "constant");
      }
      for (const m of text.matchAll(
        /\b(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/g,
      )) {
        add(m[1], "class");
      }
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 220) continue;
        if (/^\s*(\/\/|#|\*)/.test(line)) continue;
        const m = line.match(/([A-Za-z_]\w*)\s*\(/);
        if (!m) continue;
        const n = m[1];
        if (/^(if|for|while|switch|return|sizeof|defined|and|or|not|catch)$/.test(n)) {
          continue;
        }
        add(n, "method");
      }
    };
    const walk = (d, depth) => {
      if (depth > 3) return;
      let ents = [];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (/^(examples?|tests?|extras)$/i.test(e.name)) continue;
          walk(full, depth + 1);
        } else if (/\.(h|hpp)$/i.test(e.name)) {
          try {
            parseHeader(fs.readFileSync(full, "utf8"));
          } catch (_) {}
        }
      }
    };
    walk(dir, 0);
    return [...out.entries()]
      .slice(0, 800)
      .map(([label, type]) => ({ label, type }));
  }

  // Baca isi file header library (untuk viewer read-only).
  async _libFile({ name, header }) {
    const lib = (await this._libList()).find((l) => l.name === name);
    const dir =
      (lib && lib.installDir) ||
      path.join(this._arduinoPath, "libraries", String(name || ""));
    if (!dir || !fs.existsSync(dir)) throw new Error("library not found");
    const target = String(header || "").split(/[\\/]/).pop();
    if (!target) throw new Error("invalid header");
    let found = null;
    const walk = (d, depth) => {
      if (found || depth > 5) return;
      let ents = [];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of ents) {
        if (found) return;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (/^examples?$/i.test(e.name)) continue;
          walk(full, depth + 1);
        } else if (e.isFile() && e.name.toLowerCase() === target.toLowerCase()) {
          found = full;
          return;
        }
      }
    };
    walk(dir, 0);
    if (!found) throw new Error(`header not found: ${header}`);
    return { text: fs.readFileSync(found, "utf8"), path: found };
  }

  // Install library dari file .zip (library custom / offline).
  async _libInstallZip() {
    const open = await this._showOpenDialog({
      title: "Install library from .zip",
      properties: ["openFile"],
      filters: [{ name: "Zip archive", extensions: ["zip"] }],
    });
    if (open.canceled || !open.filePaths[0]) return { canceled: true };
    const zip = open.filePaths[0];
    await this._requireConfirm("Install library from zip", path.basename(zip));
    return this._runCliStream(
      this._cli(["lib", "install", "--zip-path", zip]),
    );
  }

  // Install library dari Git URL (https).
  async _libInstallGit({ url }) {
    const u = this._assertHttpUrl(url);
    await this._requireConfirm("Install library from Git", u);
    return this._runCliStream(this._cli(["lib", "install", "--git-url", u]));
  }

  // Buka folder libraries di file explorer (drop folder manual).
  async _openLibDir() {
    const shell = this._electronShell();
    if (!shell || typeof shell.openPath !== "function") {
      throw new Error("only available in the desktop app");
    }
    let dir = "";
    try {
      const j = await this._cliJson(
        this._cli(["config", "dump", "--format", "json"]),
      );
      dir =
        (j.config &&
          j.config.directories &&
          j.config.directories.user) ||
        "";
    } catch (_) {}
    if (!dir) dir = path.join(this._arduinoPath);
    const libs = path.join(dir, "libraries");
    const target = fs.existsSync(libs) ? libs : dir;
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return { ok: true, path: target };
  }

  // Buka URL di browser default (link dokumentasi library).
  async _openExternal({ url }) {
    const u = this._assertHttpUrl(url);
    const shell = this._electronShell();
    if (!shell || typeof shell.openExternal !== "function") {
      throw new Error("only available in the desktop app");
    }
    await shell.openExternal(u);
    return { ok: true };
  }

  // `lib deps` tak punya --format json. Output teks, baris nama versi.
  // ponytail: parse best-effort; upgrade ke parser kalau format berubah.
  _parseDeps(out) {
    return String(out || "")
      .split("\n")
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
      .filter((line) => line && !line.includes("✕") && !line.includes("✓"))
      .map((line) => {
        const m = line.match(/^(.+?)\s+([0-9][0-9A-Za-z.\-+]*)$/);
        return m ? { name: m[1].trim(), version: m[2] } : { name: line, version: null };
      });
  }

  // Gerbang G2 — tolak skema selain http/https (file:, data:, javascript:, jar:).
  _assertHttpUrl(input) {
    let u;
    try {
      u = new URL(String(input || ""));
    } catch (_) {
      throw new Error("invalid URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`disallowed URL scheme: ${u.protocol}`);
    }
    if (!u.host) throw new Error("URL has no host");
    return u.toString();
  }

  async _verify({ fqbn, files }) {
    // Guard in-session: satu pekerjaan berat per socket. Menutup celah
    // yang tak tertutup portLock (verify tak membuka port, tapi memakai build
    // dir yang sama).
    if (this._tool) throw new Error("another operation is running");
    this._tool = this._newArduino(fqbn, null);
    try {
      const exit = await this._tool.build(files);
      if (exit === "Aborted") return { exitCode: exit };
      if (exit !== "Success") throw new Error("Build failed");
      return { exitCode: exit };
    } finally {
      this._tool = null;
    }
  }

  async _formatCode({ code, fileName, style }) {
    if (!this._clangFmt) {
      // require ESM dari CommonJS; cache modulnya.
      this._clangFmt = await import("@wasm-fmt/clang-format");
    }
    const name = /\.(c|cc|cpp|cxx|h|hpp|ino)$/i.test(fileName || "")
      ? fileName
      : "code.cpp";
    return { text: this._clangFmt.format(String(code ?? ""), name, style || "LLVM") };
  }

  async _exportBinary({ fqbn, files }) {
    if (this._tool) throw new Error("another operation is running");
    this._tool = this._newArduino(fqbn, null);
    try {
      const exit = await this._tool.build(files, [], { exportBinaries: true });
      if (exit === "Aborted") return { exitCode: exit, aborted: true };
      if (exit !== "Success") throw new Error("Build failed");
      return { exitCode: exit, exportDir: this._tool.exportDir() };
    } finally {
      this._tool = null;
    }
  }

  async _upload({ fqbn, port, files, skipVerify }) {
    if (!port) throw new Error("port required for upload");
    if (this._tool) throw new Error("another operation is running");
    if (!portLock.acquire(port, LOCK_OWNER_UPLOAD)) {
      throw new Error(`Port ${port} is busy (monitor or block session active)`);
    }
    try {
      this._tool = this._newArduino(fqbn, port);
      this.sendRemoteRequest("setUploadAbortEnabled", { enabled: true });
      const exit = await this._tool.build(files);
      if (exit === "Aborted") {
        this.sendRemoteRequest("uploadSuccess", { aborted: true });
        return { exitCode: exit, aborted: true };
      }
      if (exit !== "Success") throw new Error("Build failed");
      this.sendRemoteRequest("setUploadAbortEnabled", { enabled: false });
      await this._tool.flash(null, { skipVerify: Boolean(skipVerify) });
      this.sendRemoteRequest("uploadSuccess", { aborted: false });
      return { exitCode: exit };
    } catch (err) {
      this.sendRemoteRequest("uploadError", { message: err.message });
      throw err;
    } finally {
      portLock.release(port, LOCK_OWNER_UPLOAD);
      this._tool = null;
    }
  }

  // ---- serial monitor (SerialPort langsung) ----
  // Bukan `arduino-cli monitor` supaya bisa KIRIM data (monitorWrite).
  // dtr/rts=false -> tak auto-reset board saat monitor dibuka.

  _monitorOpen({ port, baudRate, dtr }) {
    if (this._monitor) throw new Error("monitor already open");
    if (!portLock.acquire(port, LOCK_OWNER_MONITOR)) {
      throw new Error(`Port ${port} is busy (upload or block session active)`);
    }
    return new Promise((resolve, reject) => {
      const sp = new SerialPort({
        path: port,
        baudRate: baudRate || 9600,
        autoOpen: false,
      });
      sp.open((err) => {
        if (err) {
          portLock.release(port, LOCK_OWNER_MONITOR);
          return reject(new Error(`failed to open ${port}: ${err.message}`));
        }
        // dtr=false default: no auto-reset. Native-USB boards (Leonardo/
        // Nano 33) need DTR asserted to send data -> opt-in via `dtr`.
        const assert = Boolean(dtr);
        sp.set({ dtr: assert, rts: assert }, () => {});
        this._monitor = sp;
        this._monitorPort = port;
        this._monitorClosing = false;
        sp.on("data", (b) =>
          this.sendRemoteRequest("monitorData", { message: b.toString() }),
        );
        sp.on("error", (e) => this._monitorGone(`error: ${e.message}`));
        sp.on("close", () => this._monitorGone("port closed"));
        resolve({ ok: true });
      });
    });
  }

  // Port tertutup/error/cabut. Idempoten: setelah lock dilepas jadi no-op.
  _monitorGone(reason) {
    if (!this._monitorPort) return;
    const port = this._monitorPort;
    this._monitor = null;
    this._monitorPort = null;
    portLock.release(port, LOCK_OWNER_MONITOR);
    if (!this._monitorClosing) {
      this.sendRemoteRequest("monitorClosed", { reason });
    }
  }

  _monitorWrite({ data }) {
    if (!this._monitor) throw new Error("monitor is not open");
    return new Promise((resolve, reject) => {
      this._monitor.write(String(data ?? ""), (err) =>
        err ? reject(new Error(err.message)) : resolve({ ok: true }),
      );
    });
  }

  _monitorClose() {
    this._monitorClosing = true;
    const sp = this._monitor;
    if (sp) {
      try {
        sp.close(() => {});
      } catch (_) {}
    }
    this._monitor = null;
    if (this._monitorPort) {
      portLock.release(this._monitorPort, LOCK_OWNER_MONITOR);
      this._monitorPort = null;
    }
    return { ok: true };
  }
}

module.exports = CppSession;
