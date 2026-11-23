# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

See `../CLAUDE.md` for how this repo fits into the wider NomoKit family. This doc goes deeper on
`nomopro-desktop` itself.

Repo: `Sonasoft-Team/nomopro-desktop` (public; transferred from `Xart22`, whose old URL redirects).
`package.json` `repository` must name the Sonasoft-Team repo: electron-builder derives the GitHub
owner it publishes to — and bakes into the installers' auto-update config — from that field.

Related but not checked out here: `Xart22/nomo-link`, the standalone legacy "Nomolink" flasher this
repo's `src/link` was ported from (see the firmware-flashing section below); nomo-kit.com still
links its macOS download.

## Commands

All commands run from this directory (`npm install` first; `postinstall` runs
`electron-rebuild -f -w @abandonware/noble` automatically — this recompiles noble's native BLE
binding for Electron's ABI and requires a working native toolchain (Xcode CLT / build-essential /
Visual Studio Build Tools). It can be slow or fail silently on a machine without one; if BLE
flashing misbehaves after `npm install`, check this step first).

**Dev**
```bash
npm start                 # electron .  (opens DevTools automatically when unpackaged)
```

**Test**
```bash
npm test                  # test/run-tests.js (mocha-based smoke checks) + test/e2e/e2e-test-matrix.js
npm run test:smoke        # just test/run-tests.js
npm run test:e2e          # just test/e2e/e2e-test-matrix.js
npm run check-bundled-python   # test/smoke/check_bundled_python.js — verifies a Python interpreter resolves
```
- `test/run-tests.js` does static/structural validation (asserts specific handler names and strings
  exist in `src/main/ipc.js` / `main.js`) rather than deep behavioral testing — it's a regression
  guard against previously-fixed bugs, not full coverage.
- `test/e2e/e2e-test-matrix.js` checks **parity between the web (Pyodide) and desktop (native
  subprocess) Python runners** — same code should behave the same on both. It expects Python 3.8+ on
  PATH and, for the web half, a running `nomopro-gui` dev server.
- `test/unit/*.test.js` (file-storage, pip-manager, python-runner) are additional unit specs beside
  the two runners above.

**Build / release** (electron-builder; unsigned dev builds work without `prebuild`, but real
packaging needs it)
```bash
npm run build              # prebuild + electron-builder --win  (NSIS installer)
npm run build:mac          # prebuild + electron-builder --mac  (dmg, x64+arm64)
npm run deploy:mac / deploy:win / deploy:all   # same, plus -p always (publishes to GitHub Releases)
```
- `prebuild` = `clean:tools` (wipes `src/link/tools/Arduino/{staging,tmp}`) →
  `scripts/install_arduino_cli.js` (bundles `arduino-cli`; the app needs it at runtime) →
  `prebuild:avr` → `prebuild:avr-core` (`scripts/prepare-avr-core.js`, into `build/avr-core`) →
  `install_python_payload.js` → `build-venv.js`. `prebuild:mac` is the same.
- `prebuild:avr` runs `arduino-cli core install arduino:avr --config-file arduino-cli.yaml` **only
  if** `src/link/tools/Arduino/arduino-cli.yaml` exists and the AVR core isn't already installed
  under its configured data dir. This needs `arduino-cli` on PATH and network access to Arduino's
  package index — expect it to be slow (or to silently no-op with a console warning if the yaml is
  missing) on a fresh checkout that hasn't run `fetch:driver` yet.
- `fetch:driver` — `rimraf tools firmwares && node src/link/script/download-tools.js && node
  src/link/script/download-firmwares.js` — populates `src/link/tools/` (arduino-cli, avrdude, bossac,
  esptool, etc.) and firmware images from GitHub releases. This is a prerequisite for `src/link` to
  do anything useful and is not run automatically by `npm install`.
- `install-python-payload` (`scripts/install_python_payload.js`) downloads a portable Python
  (3.11.9) — the Windows embeddable zip or an `indygreg/python-build-standalone` tarball on macOS —
  into `python/`, which `extraResources` in `package.json` bundles into the packaged app at
  `resourcesPath/python`. Requires network access; on macOS it additionally shells out to `zstd`
  (`brew install zstd`) to decompress the `.tar.zst`. Skips re-downloading if `python/.installed`
  exists.
- Release flow: Actions → **Release desktop** → Run workflow (`release-desktop.yml`; patch / minor /
  major or an exact version, plus a dry-run option). It checks that nomo-kit.com already announces
  the `gui.lock.json` GUI to the new version, bumps `package.json` on `main`, tags `vX.Y.Z` and calls
  `release.yml`. Pushing a `vX.Y.Z` tag by hand still works; `release.yml` refuses a tag that differs
  from `package.json` `version` (electron-builder publishes by the latter).
  `.github/workflows/release.yml` builds macOS (dmg x64 + arm64) and then Windows (NSIS exe), each
  running `fetch-gui.js --check` and `npm run test:smoke` first, and electron-builder attaches both
  plus `latest*.yml` to one **draft** Release. Publishing it (pre-release for testers, full release
  for everyone — `electron-updater` follows the latest full release) is a manual step on GitHub.
  macOS builds are not signed/notarized yet. `desktop-ci.yml` builds Windows on every push/PR to
  `main` without publishing. Every job is capped at 30 minutes.

Release-relevant `package.json` quirks worth knowing before touching the build config: `asar` is
`false` and `npmRebuild` is `false` (native `@abandonware/noble`/`serialport` binaries are rebuilt
once via `postinstall`, not on every package). `files` excludes `python`, `test`, `README.md`,
`CLAUDE.md`, GUI sourcemaps and the Arduino `staging/tmp/packages` dirs from the app bundle (patterns
are case-sensitive). `python/`, `data/python-env` and `build/avr-core` are injected via
`extraResources` so they land in `resourcesPath` rather than inside the asar-less app directory.
Local Ultralytics/YOLO training output (`runs/`, `yolov8*.pt`) is gitignored so it can't ship.

## Architecture

**`src/gui` and `nomokitjr/` are not in git — `npm run fetch:gui` installs them.** They come from
the NomoKit family GitHub Release pinned in `gui.lock.json` (built by
`Sonasoft-Team/monorepo-nomopro`'s `release.yml`): `scripts/fetch-gui.js` downloads `gui.zip`,
checks it against `SHA256SUMS`, replaces `src/gui` (Pro GUI with nested `nomokitjr/`, `nomokit-ml/`,
`nomokit-cpp/`), copies `src/gui/nomokitjr` to the root `nomokitjr/` (the Pro GUI opens Jr from
`<app>/nomokitjr` under `file://`), and sets `"gui"` in `src/version.json` to the pinned tag. Run it
once after cloning, and again after changing `gui.lock.json`. It needs a token: `GITHUB_TOKEN` /
`FAMILY_REPO_TOKEN`, or a logged-in `gh`. Editing files under `src/gui` by hand does nothing durable.

**GUI version and in-app updates must move together.** On start-up `src/main/sync.js` compares
`src/version.json` `"gui"` with `"gui"` from `https://nomo-kit.com/api/check-update-dektop` and offers
the server's `gui.zip` whenever they **differ** — including when the server's is older. The server
side is `nomokit`'s `bundles.lock.json` → `desktop_gui`. So to ship a new GUI:
1. In `nomokit`, set `desktop_gui` to `{ "version": "<tag>", "from_release": true, "min_app": "<x.y.z>" }`
   and deploy. From then on, installed apps whose version is at least `min_app` (they send it as
   `?app=`) are offered that GUI as an in-app update; older apps keep the old GUI. Set `min_app` to
   the first app version that can run the new GUI (today `4.0.4`, for the Nomo C++ link session).
   Without `min_app`, every installed app is offered it.
2. Here, set `gui.lock.json` `family` to the same `<tag>`, run `npm run fetch:gui`, commit, tag `v*`.
The release workflow runs `fetch-gui.js --check`, which **refuses to build** if step 1 hasn't
happened — otherwise every fresh install would be offered a "downgrade" to the server's GUI.
After a GUI update `sync.js` also refreshes `<app>/nomokitjr` from the new `src/gui/nomokitjr`.

CI needs a `FAMILY_REPO_TOKEN` repository secret (read access to `Sonasoft-Team/monorepo-nomopro`
releases). `desktop-ci.yml` skips the GUI download without it (e.g. pull requests from forks);
`release.yml` fails without it.

**Process split.** Standard Electron main/preload/renderer. The app always boots straight into the
GUI (`src/gui/index.html`, or the dev server unpackaged): login is optional and there is no auth page.
Logging in or out never reloads or navigates the window. `main.js` wires `auth-ipc.js`, the login
pop-up parent window and `getAuth().start()` in `createWindow`; the Socket.IO connection exists only
while logged in (owned by `auth.js`). `preload.js` is the bridge for the main GUI window; `preload-update.js` is a second,
narrower bridge used only by the Arduino-tools update popup window.

**`src/main/*.js` — one helper module per concern, all wired together in `main.js`'s `createWindow`:**

| Module | Role |
|---|---|
| `auth.js` | `createAuth`: the optional desktop session (`getSession`, `completeLogin`, `login`, `logout`, `getKits`, `onChange`, `onSocket`, `start`). Owns `data/user.json`, the offline kits cache and the Socket.IO connection (created only when logged in). Never touches a window. |
| `auth-instance.js` | Singleton `getAuth()` wiring `auth.js` to axios, `node-machine-id`, the socket factory and the login window; `setAuthParentWindow(win)`. |
| `auth-window.js` | The modal login pop-up window (nomo-kit.com `/auth/popup?client=desktop`, `preload-auth.js`). |
| `auth-ipc.js` | `registerAuthIpc()`: `auth:*` IPC handlers behind `electronAPI.auth` (trusted senders only) and the `auth:changed` broadcast. |
| `ipc.js` | Core IPC: legacy `logout`/`getUserData` handlers answered from `getAuth()` (old GUI compat), plus the renderer-facing file storage API (save/read/list/delete project files under `~/Documents/OpenBlock`). |
| `socket.js` | One-device enforcement only: on `login-fail` for the current token (same account logged in elsewhere) it calls `getAuth().logout()` locally and shows a message box. No navigation, no relaunch. |
| `sync.js` | Startup self-update: `syncLibrary` pulls Arduino library bundle updates from `/api/check-update`; `syncGui`/`syncLink` poll `/api/check-update-dektop?app=<app version>` and, on version mismatch, download+extract a fresh `src/gui` or `src/link` zip (a GUI update also refreshes `<app>/nomokitjr`) and relaunch the app. |
| `usage-ping.js` | Anonymous usage count: once per packaged launch, `POST nomo-kit.com/api/desktop/ping` with a random install ID (`userData/install-id`), app/GUI version and platform/arch — no account or machine data. Fire-and-forget from `main.js` `whenReady`; `NOMOKIT_NO_USAGE_PING=1` turns it off. Numbers: `php artisan desktop:stats` in `nomokit`. |
| `link.js` | Boots the embedded `OpenBlockLink` WebSocket server (see below) and triggers a first-run/needed Arduino toolchain update via `arduino-updater.js` + `arduino-update-window.js`. |
| `arduino-updater.js` | Runs `update.sh`/`update.bat` inside `src/link/tools/Arduino` (first-time AVR core bootstrap) and generic `arduino-cli core install/uninstall` actions, streaming line-by-line progress via an `EventEmitter`. |
| `arduino-update-window.js` | A small always-on-top `BrowserWindow` (using `preload-update.js`) that renders that progress stream and blocks closing until the operation finishes. |
| `menu.js` | Builds the native app menu: install/uninstall extra Arduino cores (ESP32/ESP8266/Nano 33 BLE/Uno R4), manage local `.zip` libraries, "Check Update" (re-runs `sync.js`), "Masuk" (logged out) / "Keluar" (logged in, rebuilt on `auth.onChange`), Exit. |
| `pip-manager.js` | Per-user Python virtualenv lifecycle (bootstrap, install/uninstall/list/show packages, wheel cache) with a mutex so concurrent pip operations queue rather than race. |
| `project-deps.js` | Per-project `requirements.txt` snapshot: generate/install/import/export/diff, keyed by a sanitized `projectId`. |
| `safe-install.js` | Classifies pip packages as "safe" (pure-Python, from a large hardcoded allowlist) vs "risky" (native build required) and gates installs behind a warning/preflight check. |
| `offline-cache.js` | Wheel cache under `data/wheel-cache/<platform>-py<version>/` for offline reinstall. |
| `diagnostic-bundle.js` | Collects a support bundle: OS/hardware info, pip/runner logs, preload contract check — for troubleshooting reports. |
| `recovery-mode.js` | Self-heal for a corrupted/missing bundled Python: verifies the runtime, can re-extract it and rebuild shortcuts. |
| `logger.js` | Thin wrapper around `electron-log` (file transport, `info` level). Everything else in `src/main` logs through this. |
| `utils.js` | Shared `walkDirSize`/`copyRecursive` filesystem helpers used by diagnostics and recovery. |
| `nlp.js` | Desktop-only NLP extension (sentiment/entities/intent classification/training) shelling out to a bundled/system Python one-liner per call; not part of the licensing/update flow. |

The pip/project-deps/safe-install/offline-cache/diagnostic/recovery modules are all tagged in
comments as "Phase 7" steps — they're a fairly recent, cohesive feature set for making the bundled
Python environment self-service and resilient, layered on top of the older auth/link/sync core.

**Firmware flashing — `src/link` (ported from `nomo-link`).** `src/main/link.js` instantiates
`OpenBlockLink` (`src/link/src/index.js`), a WebSocket server on port `20111` exposing
`/openblock/ble` and `/openblock/serialport` routes (BLE route is skipped on macOS) — this is the
same "openblock-link-server" protocol/architecture used by `nomo-link`. `src/link/src/session/`
holds per-connection session handlers (`ble.js`, `serialport.js`, `session.js`); `src/link/src/upload/`
holds board-specific flashers (`arduino.js`, `microbit.js`, `micropython.js` for ESP32/RP2040).
`src/link/script/download-tools.js` and `download-firmwares.js` populate `src/link/tools` /
`firmwares` from GitHub releases — the `fetch:driver` script (`rimraf tools firmwares && node
src/link/script/download-tools.js && node src/link/script/download-firmwares.js`) is nearly a
byte-for-byte match of `nomo-link`'s own `fetch` script, and both repos share dependencies
(`@abandonware/noble`, `serialport`, `download-github-release`, `js-yaml`) — strong evidence `src/link`
is a direct port of `nomo-link`'s `link/` folder rather than an independent rewrite. `main.js` also
exposes separate `micropython-flash` / `micropython-upload` / `micropython-detect` IPC handlers that
call `src/link/src/upload/micropython.js` directly (bypassing the WebSocket server) for the
renderer's MicroPython flashing UI.

**Auxiliary windows — `src/update` and the login pop-up.** `src/update` holds plain static
HTML/CSS/JS pages (Bootstrap-styled, Indonesian-language copy), not React/GUI-framework views:
- `src/update/index.html` (+ `arduino-update.html`) — shown while `sync.js` downloads a new
  `gui`/`link` bundle, and while `arduino-update-window.js` streams Arduino toolchain install
  progress respectively.
- Login pop-up — a modal `BrowserWindow` (`auth-window.js`) over the IDE that loads
  `https://nomo-kit.com/auth/popup?client=desktop`; the token comes back through `preload-auth.js`,
  never in a URL. The IDE window is not replaced.

**Bundled Python execution flow.** Renderer calls `window.nomoproDesktopPython.runPythonCode(code)`
→ `preload.js` `ipcRenderer.invoke("nomopro-python-run", ...)` → the handler in `main.js` picks a
Python candidate via `getPythonCandidates()` (priority: per-user venv under `data/python-env` →
bundled `python/` in `resourcesPath` → system `python3`/`python`/`py`), writes the code to a temp
`.py` file (so stdin stays open for RPC-style callbacks), spawns it with `-u` (unbuffered), and
streams stdout/stderr line-by-line to the renderer via `nomopro-python-stdout`/`-stderr` events while
also buffering full output. On process close it re-parses all stdout lines as NDJSON, collecting any
line that parses as an object with a `cmd`/`action`/`args` shape into a `commands` array returned
alongside `{ exitCode, stdout, stderr, commands }`. There's also a 30s default execution timeout and
a `nomopro-python-stop`/`nomopro-python-write-stdin` pair for interactive control.

**Note:** the README documents this global as `window.openblockDesktopPython`, but the actual
`contextBridge.exposeInMainWorld` call in `preload.js` names it `nomoproDesktopPython` — that's the
name the bundled `src/gui/lib.min.js` actually calls. Trust the code over the README if they ever
disagree here. Also, `preload.js` calls `contextBridge.exposeInMainWorld("electronAPI", ...)` twice
(the whole API object, then again at the bottom with just `getAppPath`) — the second call throws in
a real contextIsolation'd renderer (`electronAPI` is already bound), so that trailing block is dead
code; don't assume both take effect.

**Auth/licensing relationship to `nomokit` (Laravel backend).** Confirmed from source (not just
inference): the old `src/main/ipc.js` `login` handler (replaced by the shared login pop-up; `auth.js` now calls
`/api/desktop/bind` with `{ hwid, app: "nomopro" }`) `axios.post`ed to
`https://nomo-kit.com/api/login` with `{ email, password, hwid, app: "nomopro" }` — `hwid` from
`node-machine-id`'s `machineIdSync()` — which lines up with `nomokit`'s `routes/api.php` `POST
/login` route and the `hwid` / `hwid_pro` / `hwid_jr` fillable fields on `nomokit`'s `User` model
(`app/Models/User.php`); the `app: "nomopro"` tag strongly suggests the backend uses it to pick
which `hwid_*` column to bind, though the exact selection logic lives in `nomokit`'s
`AuthController` and wasn't re-verified here. `src/main/sync.js` polls
`https://nomo-kit.com/api/check-update-dektop` (matching `nomokit`'s
`CheckUpdateController::checkUpdateDesktop` route, typo included) to decide whether to download a
newer `src/gui`/`src/link` bundle, and a separate `/api/check-update` call drives the Arduino
library sync. `socket.js` logs out locally (`auth.logout()`, which also makes a best-effort `nomo-kit.com/api/logout`)
when it detects a concurrent login from elsewhere (`login-fail` socket event); no relaunch. The desktop app does **not**
appear to call `API\KitController::show` (the entitlement/serial-number-unlock endpoint documented in
`nomokit/CLAUDE.md`) directly from anything read here — that check is likely performed
server-side as part of what the bundled `src/gui` build fetches at runtime, not from this repo's own
main-process code.
