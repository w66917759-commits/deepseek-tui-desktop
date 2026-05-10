#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function binaryName(base, platform = process.platform) {
  return platform === "win32" ? `${base}.exe` : base;
}

function defaultUpstreamRoot() {
  return process.env.DEEPSEEK_DESKTOP_LOCAL_RUNTIME_ROOT
    ? path.resolve(process.env.DEEPSEEK_DESKTOP_LOCAL_RUNTIME_ROOT)
    : path.resolve(__dirname, "..", "..", "DeepSeek-TUI");
}

function defaultDownloadsDir() {
  return path.resolve(__dirname, "..", "node_modules", "deepseek-tui", "bin", "downloads");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    build: true,
    upstreamRoot: defaultUpstreamRoot(),
    downloadsDir: defaultDownloadsDir(),
    version: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-build") {
      options.build = false;
      continue;
    }
    if (arg === "--upstream-root") {
      options.upstreamRoot = path.resolve(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--downloads-dir") {
      options.downloadsDir = path.resolve(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--version") {
      options.version = String(argv[index + 1] || "").trim();
      index += 1;
    }
  }

  return options;
}

function buildLocalRuntimeSyncPlan(options = {}) {
  const upstreamRoot = path.resolve(options.upstreamRoot || defaultUpstreamRoot());
  const downloadsDir = path.resolve(options.downloadsDir || defaultDownloadsDir());
  const sourceDir = path.join(upstreamRoot, "target", "release");
  const artifacts = [
    {
      name: "deepseek",
      sourcePath: path.join(sourceDir, binaryName("deepseek")),
      targetPath: path.join(downloadsDir, binaryName("deepseek")),
      versionPath: path.join(downloadsDir, `${binaryName("deepseek")}.version`)
    },
    {
      name: "deepseek-tui",
      sourcePath: path.join(sourceDir, binaryName("deepseek-tui")),
      targetPath: path.join(downloadsDir, binaryName("deepseek-tui")),
      versionPath: path.join(downloadsDir, `${binaryName("deepseek-tui")}.version`)
    }
  ];

  for (const artifact of artifacts) {
    if (!fs.existsSync(artifact.sourcePath)) {
      throw new Error(`Missing local runtime binary: ${artifact.sourcePath}`);
    }
  }

  return {
    upstreamRoot,
    sourceDir,
    downloadsDir,
    artifacts
  };
}

function ensureLocalRuntimeBuilt(upstreamRoot) {
  const result = spawnSync(
    "cargo",
    ["build", "--release", "--locked", "-p", "deepseek-tui-cli", "-p", "deepseek-tui"],
    {
      cwd: upstreamRoot,
      encoding: "utf8",
      stdio: "pipe"
    }
  );

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(
      `Failed to build local runtime in ${upstreamRoot}\n${stderr || stdout || "cargo build exited with a non-zero status"}`
    );
  }
}

function copyArtifact(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  try {
    fs.chmodSync(targetPath, 0o755);
  } catch {
    // Ignore chmod failures on platforms that do not support POSIX modes.
  }
}

function syncLocalRuntime(options = {}) {
  const build = options.build !== false;
  const upstreamRoot = path.resolve(options.upstreamRoot || defaultUpstreamRoot());
  const downloadsDir = path.resolve(options.downloadsDir || defaultDownloadsDir());
  if (build) {
    ensureLocalRuntimeBuilt(upstreamRoot);
  }
  const plan = buildLocalRuntimeSyncPlan({ upstreamRoot, downloadsDir });
  const version = String(options.version || "").trim() || "local-source";

  for (const artifact of plan.artifacts) {
    copyArtifact(artifact.sourcePath, artifact.targetPath);
    fs.writeFileSync(artifact.versionPath, `${version}\n`);
  }

  return {
    upstreamRoot: plan.upstreamRoot,
    downloadsDir: plan.downloadsDir,
    version,
    artifacts: plan.artifacts.map((artifact) => ({
      name: artifact.name,
      sourcePath: artifact.sourcePath,
      targetPath: artifact.targetPath,
      versionPath: artifact.versionPath
    }))
  };
}

function main() {
  const options = parseArgs();
  const result = syncLocalRuntime(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  binaryName,
  buildLocalRuntimeSyncPlan,
  defaultDownloadsDir,
  defaultUpstreamRoot,
  parseArgs,
  syncLocalRuntime
};
