/**
 * electron-builder afterPack hook: ad-hoc sign the macOS app when no real signing identity is set.
 *
 * Without a Developer ID certificate electron-builder skips signing, which leaves only Electron's
 * own linker signature on the main binary. The bundle then fails `codesign --verify`, and macOS
 * tells users who downloaded it that the app "is damaged and can't be opened" (Move to Trash).
 * A consistent ad-hoc signature over the whole bundle turns that into the normal "unidentified
 * developer" prompt (Privacy & Security -> Open Anyway). It is not notarization; once a Developer ID
 * certificate is configured (CSC_LINK / CSC_NAME), this hook steps aside and electron-builder signs.
 *
 * electron-builder 24.x has no `identity: "-"` option, hence this hook (runs before the dmg is made).
 */
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
