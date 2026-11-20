#!/usr/bin/env node
/**
 * Install the Pro GUI into this app from a NomoKit family GitHub Release.
 *
 * src/gui and nomokitjr/ are no longer committed. They come from the release pinned in
 * gui.lock.json (built by Sonasoft-Team/monorepo-nomopro's release.yml), so the desktop app and
 * nomo-kit.com ship byte-identical GUI code and every installer records which source built it.
 *
 *   node scripts/fetch-gui.js            download, verify, install
 *   node scripts/fetch-gui.js --check    also require nomo-kit.com's update API to announce the
 *                                        same GUI version to this app version (release builds)
 *
 * What it does:
 *   1. reads gui.lock.json -> { family_repo, family }
 *   2. downloads gui.zip and SHA256SUMS from that release and verifies the checksum
 *   3. replaces src/gui with the zip's contents, and nomokitjr/ with src/gui/nomokitjr
 *      (the Pro GUI opens Jr from <app>/nomokitjr under file://)
 *   4. sets "gui" in src/version.json to the pinned tag
 *
 * Why --check exists: on start-up the app compares its src/version.json "gui" with the "gui"
 * returned by https://nomo-kit.com/api/check-update-dektop and offers gui.zip from the server
 * whenever they DIFFER. An installer whose GUI version the server does not announce would tell
 * every fresh install to "update" to the server's (older) GUI. So the server must be switched to
 * the new version first (nomokit bundles.lock.json -> desktop_gui), then the installer released.
 *
 * Token: GITHUB_TOKEN or FAMILY_REPO_TOKEN (read access to the family repo's releases).
 * Locally, if neither is set, `gh auth token` is used when the GitHub CLI is logged in.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const extract = require("extract-zip");

const ROOT = path.resolve(__dirname, "..");
const GUI_DIR = path.join(ROOT, "src", "gui");
const JR_DIR = path.join(ROOT, "nomokitjr");
const VERSION_FILE = path.join(ROOT, "src", "version.json");
const UPDATE_API = "https://nomo-kit.com/api/check-update-dektop";

const CHECK = process.argv.includes("--check");

function fail(msg) {
  console.error("fetch-gui: " + msg);
  process.exit(1);
}

function token() {
  const t = process.env.GITHUB_TOKEN || process.env.FAMILY_REPO_TOKEN;
  if (t) return t.trim();
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    fail("no token: set GITHUB_TOKEN (or FAMILY_REPO_TOKEN), or log in with `gh auth login`");
  }
}

async function gh(url, tok, accept = "application/vnd.github+json") {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tok}`, Accept: accept, "User-Agent": "nomopro-desktop-fetch-gui" },
    redirect: "follow",
  });
  if (!res.ok) fail(`${res.status} ${res.statusText} for ${url.replace(/\/assets\/\d+$/, "/assets/<id>")}`);
  return res;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "gui.lock.json"), "utf8"));
  const { family_repo: repo, family: tag } = lock;
  if (!repo || !tag) fail("gui.lock.json needs family_repo and family");

  if (CHECK) {
    // Ask exactly what an installed copy of THIS build will be told: the app sends its version.
    const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const res = await fetch(`${UPDATE_API}?app=${encodeURIComponent(appVersion)}`);
    if (!res.ok) fail(`cannot reach ${UPDATE_API} (${res.status})`);
    const announced = (await res.json()).gui;
    if (announced !== tag) {
      fail(
        `nomo-kit.com announces GUI "${announced}" but this build pins "${tag}".\n` +
          `  Installed apps would be told to replace this GUI with "${announced}".\n` +
          `  Switch the server first: in nomokit, set bundles.lock.json desktop_gui to ` +
          `{ "version": "${tag}", "from_release": true, "min_app": "<lowest app version that can run it>" }` +
          ` and deploy (app ${appVersion} must be >= min_app), then release again.`,
      );
    }
    console.log(`fetch-gui: nomo-kit.com already announces ${tag}`);
  }

  const tok = token();
  console.log(`fetch-gui: ${repo}@${tag}`);
  const rel = await (await gh(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, tok)).json();
  const asset = (name) => rel.assets.find((a) => a.name === name) || fail(`${name} missing from ${tag}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nomopro-gui-"));
  try {
    for (const name of ["gui.zip", "SHA256SUMS"]) {
      const res = await gh(asset(name).url, tok, "application/octet-stream");
      fs.writeFileSync(path.join(tmp, name), Buffer.from(await res.arrayBuffer()));
    }

    const sums = fs.readFileSync(path.join(tmp, "SHA256SUMS"), "utf8");
    const line = sums.split("\n").find((l) => l.trim().endsWith(" gui.zip"));
    if (!line) fail("gui.zip is not listed in SHA256SUMS");
    const expected = line.trim().split(/\s+/)[0];
    const actual = sha256(path.join(tmp, "gui.zip"));
    if (expected !== actual) fail(`gui.zip checksum mismatch (expected ${expected}, got ${actual})`);
    console.log("fetch-gui: checksum ok");

    const unpacked = path.join(tmp, "gui");
    await extract(path.join(tmp, "gui.zip"), { dir: unpacked });
    for (const f of ["index.html", "manifest.json", "nomokitjr/index.html", "nomokit-ml/index.html", "nomokit-cpp/index.html"]) {
      if (!fs.existsSync(path.join(unpacked, f))) fail(`${f} missing from gui.zip`);
    }

    fs.rmSync(GUI_DIR, { recursive: true, force: true });
    fs.cpSync(unpacked, GUI_DIR, { recursive: true });
    fs.rmSync(JR_DIR, { recursive: true, force: true });
    fs.cpSync(path.join(GUI_DIR, "nomokitjr"), JR_DIR, { recursive: true });

    const version = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
    if (version.gui !== tag) {
      version.gui = tag;
      fs.writeFileSync(VERSION_FILE, JSON.stringify(version, null, 2) + "\n");
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(GUI_DIR, "manifest.json"), "utf8"));
    console.log(`fetch-gui: installed ${tag} into src/gui and nomokitjr/`);
    for (const [k, v] of Object.entries(manifest.sources || {})) console.log(`  ${k.padEnd(20)} ${v}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => fail(e.stack || String(e)));
