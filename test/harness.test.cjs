const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DeepSeekDesktopHarness, defaultSettings } = require("../electron/harness.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function makeFakeRuntime(appRoot) {
  const runtimePath = path.join(
    appRoot,
    "node_modules",
    "deepseek-tui",
    "bin",
    "downloads",
    process.platform === "win32" ? "deepseek.exe" : "deepseek"
  );
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, "#!/bin/sh\necho deepseek 0.0.0\n");
  if (process.platform !== "win32") {
    fs.chmodSync(runtimePath, 0o755);
  }
  return runtimePath;
}

function fakeApp(userDataPath, appPath) {
  return {
    isPackaged: false,
    getAppPath() {
      return appPath;
    },
    getPath(name) {
      if (name === "userData") {
        return userDataPath;
      }
      return path.join(userDataPath, name);
    }
  };
}

function createHarnessContext() {
  const root = makeTempRoot("dstui-harness");
  const userData = path.join(root, "userData");
  const appRoot = path.join(root, "app");
  const workspace = path.join(root, "workspace");
  const runtime = makeFakeRuntime(appRoot);
  fs.mkdirSync(workspace, { recursive: true });

  return {
    root,
    userData,
    appRoot,
    workspace,
    runtime,
    harness: new DeepSeekDesktopHarness(fakeApp(userData, appRoot))
  };
}

test("settings persistence sanitizes unsafe fields and fills runtime defaults", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const settings = ctx.harness.writeSettings({
    language: "en",
    provider: "nvidia-nim",
    baseUrl: "",
    apiKey: "sk-should-not-be-stored-here",
    agentPrompt: "hidden prompt",
    mobileBridgeHost: " 0.0.0.0 ",
    mobileBridgePort: 22,
    mobileBridgeToken: "short",
    enabledSkills: "not-an-array",
    mcpEnabled: "yes"
  });

  assert.equal(settings.language, "en");
  assert.equal(settings.provider, "nvidia-nim");
  assert.equal(settings.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(settings.mobileBridgeHost, "0.0.0.0");
  assert.equal(settings.mobileBridgePort, 8765);
  assert.equal(settings.mobileBridgeToken.length >= 20, true);
  assert.deepEqual(settings.enabledSkills, ["superpowers", "ui-ux-design", "cron-scheduler", "skill-downloader"]);
  assert.equal(settings.mcpEnabled, true);
  assert.equal(Object.hasOwn(settings, "apiKey"), false);
  assert.equal(Object.hasOwn(settings, "agentPrompt"), false);

  const rawSettings = fs.readFileSync(path.join(ctx.userData, "settings.json"), "utf8");
  assert.equal(rawSettings.includes("sk-should-not-be-stored-here"), false);
  assert.equal(rawSettings.includes("hidden prompt"), false);
});

test("settings default and legacy sub-agent limits migrate to DeepSeek default", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const missingLimit = ctx.harness.writeSettings({
    language: "en",
    enabledSkills: ["superpowers"]
  });
  assert.equal(missingLimit.maxSubagents, 10);

  const legacyLimit = ctx.harness.writeSettings({
    ...defaultSettings(),
    maxSubagents: 3
  });
  assert.equal(legacyLimit.maxSubagents, 10);

  const customLimit = ctx.harness.writeSettings({
    ...defaultSettings(),
    maxSubagents: 7
  });
  assert.equal(customLimit.maxSubagents, 7);

  const legacyPlan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "Ping",
    maxSubagents: 3
  });
  assert.equal(legacyPlan.env.DEEPSEEK_MAX_SUBAGENTS, "10");
});

test("default conversation skills include daily task and Skill download guidance", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const settings = ctx.harness.writeSettings({
    ...defaultSettings(),
    workspacePath: ctx.workspace,
    binaryMode: "bundled"
  });
  assert.deepEqual(settings.enabledSkills, ["superpowers", "ui-ux-design", "cron-scheduler", "skill-downloader"]);

  const plan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "Create a daily task and download a Skill."
  });

  assert.equal(plan.env.DEEPSEEK_DESKTOP_ENABLED_SKILLS, "superpowers,ui-ux-design,cron-scheduler,skill-downloader");
  assert.equal(
    fs.existsSync(path.join(plan.env.DEEPSEEK_SKILLS_DIR, "cron-scheduler", "scripts", "write-cron-file.mjs")),
    true
  );
  const skillDownloaderPath = path.join(plan.env.DEEPSEEK_SKILLS_DIR, "skill-downloader", "SKILL.md");
  assert.equal(fs.existsSync(skillDownloaderPath), true);
  const skillDownloader = fs.readFileSync(skillDownloaderPath, "utf8");
  assert.match(skillDownloader, /curl -fsSL/);
  assert.match(skillDownloader, /Do not synthesize/);
});

test("launch plans include MCP, skills, saved credentials, and plan-mode prompt", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  ctx.harness.writeSettings({
    ...defaultSettings(),
    workspacePath: ctx.workspace,
    binaryMode: "bundled"
  });
  ctx.harness.saveApiKey({ provider: "deepseek", apiKey: "sk-test-secret" });

  const plan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "plan",
    agentPrompt: "Refactor the settings panel",
    mcpEnabled: true,
    enabledMcpServers: ["filesystem"],
    skillsEnabled: true,
    enabledSkills: ["superpowers", "cron-scheduler"],
    allowShell: true,
    maxSubagents: 7
  });

  assert.equal(plan.command, ctx.runtime);
  assert.equal(plan.runtime.selectedExists, true);
  assert.equal(plan.cwd, ctx.workspace);
  assert.deepEqual(plan.args.slice(0, 3), ["exec", "--enable", "mcp"]);
  assert.equal(plan.args.includes("--auto"), true);
  assert.match(plan.args.at(-1), /You are in Plan mode/);
  assert.match(plan.args.at(-1), /Refactor the settings panel/);
  assert.equal(plan.env.DEEPSEEK_API_KEY, "sk-test-secret");
  assert.equal(plan.env.DEEPSEEK_ALLOW_SHELL, "1");
  assert.equal(plan.env.DEEPSEEK_MAX_SUBAGENTS, "7");
  assert.equal(plan.env.DEEPSEEK_DESKTOP_ENABLED_MCP, "filesystem");
  assert.equal(plan.env.DEEPSEEK_DESKTOP_ENABLED_SKILLS, "superpowers,cron-scheduler");

  const mcpConfig = JSON.parse(fs.readFileSync(plan.env.DEEPSEEK_MCP_CONFIG, "utf8"));
  assert.deepEqual(mcpConfig.servers.filesystem.args, [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    ctx.workspace
  ]);

  assert.equal(fs.existsSync(path.join(plan.env.DEEPSEEK_SKILLS_DIR, "superpowers", "SKILL.md")), true);
  assert.equal(
    fs.existsSync(path.join(plan.env.DEEPSEEK_SKILLS_DIR, "cron-scheduler", "scripts", "write-cron-file.mjs")),
    true
  );
});

test("DeepSeek V4 1M UI selections resolve to official API model ids", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  ctx.harness.writeSettings({
    ...defaultSettings(),
    workspacePath: ctx.workspace,
    binaryMode: "bundled",
    provider: "deepseek",
    model: "deepseek-v4-flash-1m"
  });

  const flashPlan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "Ping",
    model: "deepseek-v4-flash-1m"
  });
  assert.equal(flashPlan.env.DEEPSEEK_MODEL, "deepseek-v4-flash");

  const proPlan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "Ping",
    model: "deepseek-v4-pro-1m"
  });
  assert.equal(proPlan.env.DEEPSEEK_MODEL, "deepseek-v4-pro");
});

test("desktop harness mode is opt-in for launch plans", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  ctx.harness.writeSettings({
    ...defaultSettings(),
    workspacePath: ctx.workspace,
    binaryMode: "bundled"
  });

  const defaultPlan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "List files"
  });
  assert.equal(Object.hasOwn(defaultPlan.env, "DEEPSEEK_DESKTOP_HARNESS"), false);

  const harnessPlan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "List files",
    harnessEnabled: true
  });
  assert.equal(harnessPlan.env.DEEPSEEK_DESKTOP_HARNESS, "1");
});

test("process stream toggle writes DeepSeek reasoning managed config", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const offPlan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "Ping",
    harnessEnabled: false
  });

  assert.equal(
    offPlan.env.DEEPSEEK_MANAGED_CONFIG_PATH,
    path.join(ctx.userData, "deepseek.desktop.managed.toml")
  );
  assert.match(
    fs.readFileSync(offPlan.env.DEEPSEEK_MANAGED_CONFIG_PATH, "utf8"),
    /reasoning_effort = "off"/
  );

  const streamPlan = ctx.harness.buildLaunchPlan({
    workspacePath: ctx.workspace,
    launchAction: "exec",
    agentPrompt: "Ping",
    harnessEnabled: true
  });

  assert.equal(
    streamPlan.env.DEEPSEEK_MANAGED_CONFIG_PATH,
    path.join(ctx.userData, "deepseek.desktop.managed.toml")
  );
  assert.match(
    fs.readFileSync(streamPlan.env.DEEPSEEK_MANAGED_CONFIG_PATH, "utf8"),
    /reasoning_effort = "max"/
  );
});

test("automation cron files keep secrets out and persist runner metadata", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const settings = {
    ...defaultSettings(),
    workspacePath: ctx.workspace,
    binaryMode: "custom",
    customBinaryPath: ctx.runtime,
    provider: "nvidia-nim",
    model: "nim-test-model",
    baseUrl: "https://nim.example/v1",
    skillsEnabled: false,
    mcpEnabled: false,
    allowShell: true,
    maxSubagents: 2
  };
  ctx.harness.writeSettings(settings);
  ctx.harness.saveApiKey({ provider: "nvidia-nim", apiKey: "nvapi-secret" });

  const result = ctx.harness.writeAutomationCronFile({
    id: "automation-test",
    name: "Daily Audit",
    prompt: "Summarize the project status",
    workspacePath: ctx.workspace,
    schedule: "15 7 * * *",
    timezone: "Asia/Shanghai",
    status: "PAUSED"
  }, settings);

  assert.equal(result.ok, true);
  assert.equal(result.task.status, "PAUSED");
  assert.deepEqual(result.task.runArgs, ["exec", "--auto", "Summarize the project status"]);
  assert.equal(result.task.provider, "nvidia-nim");
  assert.equal(result.task.model, "nim-test-model");
  assert.equal(result.task.baseUrl, "https://nim.example/v1");
  assert.equal(fs.existsSync(result.task.runnerPath), true);

  const cronText = fs.readFileSync(result.task.cronPath, "utf8");
  assert.match(cronText, /CRON_TZ="Asia\/Shanghai"/);
  assert.match(cronText, /DEEPSEEK_PROVIDER="nvidia-nim"/);
  assert.match(cronText, /DEEPSEEK_BASE_URL="https:\/\/nim\.example\/v1"/);
  assert.match(cronText, /DEEPSEEK_ALLOW_SHELL=1/);
  assert.match(cronText, /automation-runner\.cjs/);
  assert.equal(cronText.includes("nvapi-secret"), false);
});

test("automation cron files canonicalize DeepSeek V4 1M model selections", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const settings = {
    ...defaultSettings(),
    workspacePath: ctx.workspace,
    binaryMode: "custom",
    customBinaryPath: ctx.runtime,
    provider: "deepseek",
    model: "deepseek-v4-pro-1m",
    baseUrl: "https://api.deepseek.com"
  };

  const result = ctx.harness.writeAutomationCronFile({
    id: "deepseek-model-test",
    name: "Model Test",
    prompt: "Summarize",
    workspacePath: ctx.workspace,
    schedule: "0 8 * * *",
    timezone: "Asia/Shanghai",
    status: "PAUSED"
  }, settings);

  assert.equal(result.ok, true);
  assert.equal(result.task.model, "deepseek-v4-pro");
  const cronText = fs.readFileSync(result.task.cronPath, "utf8");
  assert.match(cronText, /DEEPSEEK_MODEL="deepseek-v4-pro"/);
});

test("git helpers report non-repo state, initialize safely, and validate GitHub remotes", (t) => {
  const ctx = createHarnessContext();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const before = ctx.harness.gitStatus(ctx.workspace);
  assert.equal(before.ok, true);
  assert.equal(before.isRepo, false);

  const init = ctx.harness.gitInit(ctx.workspace);
  assert.equal(init.ok, true, init.error || init.output);
  assert.equal(init.status.isRepo, true);

  fs.writeFileSync(path.join(ctx.workspace, "README.md"), "# Temporary repo\n");
  const status = ctx.harness.gitStatus(ctx.workspace);
  assert.equal(status.hasChanges, true);
  assert.equal(status.untracked, 1);
  assert.equal(status.changes[0].path, "README.md");

  const badRemote = ctx.harness.gitSetRemote({
    workspacePath: ctx.workspace,
    remoteUrl: "https://example.com/not-github/repo.git"
  });
  assert.equal(badRemote.ok, false);
  assert.match(badRemote.error, /GitHub/);

  const goodRemote = ctx.harness.gitSetRemote({
    workspacePath: ctx.workspace,
    remoteUrl: "https://github.com/example/deepseek-tui-desktop.git"
  });
  assert.equal(goodRemote.ok, true, goodRemote.error || goodRemote.output);
  assert.equal(goodRemote.status.originUrl, "https://github.com/example/deepseek-tui-desktop.git");

  const diff = ctx.harness.gitDiffSummary({ workspacePath: ctx.workspace });
  assert.equal(diff.ok, true, diff.error);
  assert.match(diff.output, /README\.md/);
});

test("cron scheduler script validates input, quotes env values, and escapes percent characters", (t) => {
  const root = makeTempRoot("dstui-cron-script");
  const workspace = path.join(root, "workspace");
  const outPath = path.join(root, "daily.cron");
  fs.mkdirSync(workspace, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, "electron", "skills", "cron-scheduler", "scripts", "write-cron-file.mjs"),
    "--name",
    "Daily Report",
    "--schedule",
    "0 5 * * *",
    "--command",
    "npm run report -- --ratio 50%",
    "--cwd",
    workspace,
    "--timezone",
    "Asia/Shanghai",
    "--out",
    outPath,
    "--env",
    "DEEPSEEK_MODEL=deepseek v4"
  ], {
    cwd: PROJECT_ROOT,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.path, outPath);

  const cronText = fs.readFileSync(outPath, "utf8");
  assert.match(cronText, /CRON_TZ=Asia\/Shanghai/);
  assert.match(cronText, /DEEPSEEK_MODEL="deepseek v4"/);
  assert.match(cronText, /50\\%/);
  assert.equal(cronText.includes(`cd '${workspace}'`), true);
});
