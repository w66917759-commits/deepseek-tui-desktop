const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");
const {
  buildLocalRuntimeSyncPlan,
  syncLocalRuntime
} = require("../scripts/sync-local-runtime.cjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

test("package.json exposes a local runtime sync command", () => {
  assert.equal(packageJson.scripts["runtime:sync-local"], "node scripts/sync-local-runtime.cjs");
});

test("buildLocalRuntimeSyncPlan requires both local upstream binaries", () => {
  const upstreamRoot = makeTempDir("deepseek-upstream-missing-");
  const downloadsDir = makeTempDir("deepseek-downloads-missing-");

  try {
    writeExecutable(
      path.join(upstreamRoot, "target", "release", "deepseek-tui"),
      "runtime-only"
    );

    assert.throws(
      () => buildLocalRuntimeSyncPlan({ upstreamRoot, downloadsDir }),
      /deepseek/
    );
  } finally {
    fs.rmSync(upstreamRoot, { recursive: true, force: true });
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});

test("syncLocalRuntime copies dispatcher, companion runtime, and version markers", () => {
  const upstreamRoot = makeTempDir("deepseek-upstream-");
  const downloadsDir = makeTempDir("deepseek-downloads-");

  try {
    writeExecutable(
      path.join(upstreamRoot, "target", "release", "deepseek"),
      "dispatcher-binary"
    );
    writeExecutable(
      path.join(upstreamRoot, "target", "release", "deepseek-tui"),
      "runtime-binary"
    );

    const result = syncLocalRuntime({
      upstreamRoot,
      downloadsDir,
      build: false,
      version: "local-dev"
    });

    assert.equal(result.version, "local-dev");
    assert.equal(
      fs.readFileSync(path.join(downloadsDir, "deepseek"), "utf8"),
      "dispatcher-binary"
    );
    assert.equal(
      fs.readFileSync(path.join(downloadsDir, "deepseek-tui"), "utf8"),
      "runtime-binary"
    );
    assert.equal(
      fs.readFileSync(path.join(downloadsDir, "deepseek.version"), "utf8"),
      "local-dev\n"
    );
    assert.equal(
      fs.readFileSync(path.join(downloadsDir, "deepseek-tui.version"), "utf8"),
      "local-dev\n"
    );
    assert.deepEqual(
      result.artifacts.map((artifact) => path.basename(artifact.targetPath)).sort(),
      ["deepseek", "deepseek-tui"]
    );
  } finally {
    fs.rmSync(upstreamRoot, { recursive: true, force: true });
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  }
});
