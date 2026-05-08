const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const pkg = require("../package.json");
const PROJECT_ROOT = path.resolve(__dirname, "..");

function runNodeScript(script, args = []) {
  return spawnSync(process.execPath, [path.join(PROJECT_ROOT, script), ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8"
  });
}

test("Windows packaging config targets a local-test x64 NSIS installer", () => {
  assert.match(pkg.scripts["prepare:win-runtime"], /scripts\/prepare-win-runtime\.cjs/);
  assert.match(pkg.scripts["cert:win:self-signed"], /scripts\/create-win-test-cert\.cjs/);
  assert.match(pkg.scripts["dist:win"], /prepare:win-runtime/);
  assert.match(pkg.scripts["dist:win"], /electron-builder --win nsis --x64/);
  assert.match(pkg.scripts["dist:win"], /-c\.npmRebuild=false/);
  assert.match(pkg.scripts["dist:win:test"], /scripts\/dist-win-test\.cjs/);

  assert.equal(pkg.build.win.icon, "build/icon.ico");
  assert.equal(pkg.build.win.requestedExecutionLevel, "asInvoker");
  assert.equal(pkg.build.win.verifyUpdateCodeSignature, false);
  assert.equal(pkg.build.win.signtoolOptions.publisherName, "DeepSeek TUI Desktop Local Test");
  assert.deepEqual(pkg.build.win.signtoolOptions.signingHashAlgorithms, ["sha256"]);
  assert.deepEqual(pkg.build.win.target, [{ target: "nsis", arch: ["x64"] }]);

  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(pkg.build.nsis.createDesktopShortcut, true);
});

test("packaging config unpacks bundled skill directories for packaged startup", () => {
  assert.ok(
    pkg.build.asarUnpack.includes("electron/skills/**"),
    "packaged app must copy bundled Skill directories from app.asar.unpacked"
  );
});

test("Windows runtime prepare script dry-runs the upstream Windows x64 assets", () => {
  const result = runNodeScript("scripts/prepare-win-runtime.cjs", ["--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.platform, "win32");
  assert.equal(parsed.arch, "x64");
  assert.deepEqual(parsed.assets.map((asset) => asset.assetName), [
    "deepseek-windows-x64.exe",
    "deepseek-tui-windows-x64.exe"
  ]);
  assert.deepEqual(parsed.assets.map((asset) => path.basename(asset.targetPath)), [
    "deepseek.exe",
    "deepseek-tui.exe"
  ]);
});

test("Windows self-signed certificate script dry-runs an ignored local PFX", () => {
  const result = runNodeScript("scripts/create-win-test-cert.cjs", ["--dry-run", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.publisher, "DeepSeek TUI Desktop Local Test");
  assert.match(parsed.pfxPath, /build[/\\]certs[/\\]deepseek-tui-desktop-local-test\.pfx$/);
  assert.equal(parsed.passwordEnv, "DEEPSEEK_TUI_WIN_CERT_PASSWORD");
});
