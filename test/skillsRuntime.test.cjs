const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DeepSeekDesktopHarness, defaultSettings } = require("../electron/harness.cjs");

function createHarness() {
  const userData = mkdtempSync(path.join(tmpdir(), "deepseek-tui-desktop-test-"));
  const app = {
    getPath(name) {
      if (name !== "userData") throw new Error(`Unexpected app path ${name}`);
      return userData;
    },
    getAppPath() {
      return path.join(__dirname, "..");
    }
  };
  return {
    harness: new DeepSeekDesktopHarness(app),
    userData,
    cleanup() {
      rmSync(userData, { recursive: true, force: true });
    }
  };
}

test("scheduled tasks are represented as an enabled runtime skill", () => {
  const settings = defaultSettings();

  assert.ok(settings.enabledSkills.includes("scheduled-task-agent"));
});

test("runtime launch writes the scheduled task skill into the injected skills dir", () => {
  const { harness, userData, cleanup } = createHarness();
  try {
    const workspace = mkdtempSync(path.join(tmpdir(), "deepseek-tui-workspace-"));
    const plan = harness.buildLaunchPlan({
      ...defaultSettings(),
      workspacePath: workspace,
      launchAction: "exec",
      agentPrompt: "帮我写一个每天运行的任务",
      enabledSkills: ["scheduled-task-agent"],
      skillsEnabled: true
    });
    const skillPath = path.join(plan.env.DEEPSEEK_SKILLS_DIR, "scheduled-task-agent", "SKILL.md");
    const skillContent = readFileSync(skillPath, "utf8");

    assert.equal(plan.env.DEEPSEEK_DESKTOP_ENABLED_SKILLS, "scheduled-task-agent");
    assert.match(skillContent, /automation_create/);
    assert.match(skillContent, /scheduled task/i);
    rmSync(workspace, { recursive: true, force: true });
  } finally {
    cleanup();
    assert.ok(userData);
  }
});

test("existing default skill selections migrate to include scheduled task skill", () => {
  const { harness, cleanup } = createHarness();
  try {
    const saved = harness.writeSettings({
      ...defaultSettings(),
      skillPresetVersion: 4,
      enabledSkills: ["superpowers", "ui-ux-pro-max", "cron-scheduler", "skill-downloader"]
    });

    assert.ok(saved.enabledSkills.includes("scheduled-task-agent"));
  } finally {
    cleanup();
  }
});

test("reading legacy default settings writes scheduled task skill migration back to disk", () => {
  const { harness, userData, cleanup } = createHarness();
  try {
    const settingsPath = path.join(userData, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      ...defaultSettings(),
      mobileBridgeToken: "existing-token-that-should-not-block-migration",
      skillPresetVersion: 4,
      enabledSkills: ["superpowers", "ui-ux-pro-max", "cron-scheduler", "skill-downloader"]
    }, null, 2));

    const readSettings = harness.readSettings();
    const persisted = JSON.parse(readFileSync(settingsPath, "utf8"));

    assert.ok(readSettings.enabledSkills.includes("scheduled-task-agent"));
    assert.ok(persisted.enabledSkills.includes("scheduled-task-agent"));
    assert.equal(persisted.skillPresetVersion, 5);
  } finally {
    cleanup();
  }
});

test("scheduled task skill injects the internal automation MCP bridge without external MCP", () => {
  const { harness, cleanup } = createHarness();
  try {
    const workspace = mkdtempSync(path.join(tmpdir(), "deepseek-tui-workspace-"));
    const plan = harness.buildLaunchPlan({
      ...defaultSettings(),
      workspacePath: workspace,
      launchAction: "exec",
      agentPrompt: "每天 9 点检查项目状态",
      enabledSkills: ["scheduled-task-agent"],
      skillsEnabled: true,
      mcpEnabled: false,
      enabledMcpServers: []
    });

    assert.ok(plan.args.includes("--enable"));
    assert.ok(plan.args.includes("mcp"));
    assert.ok(plan.env.DEEPSEEK_MCP_CONFIG);
    assert.equal(plan.env.DEEPSEEK_DESKTOP_AUTOMATION_MCP, "1");
    assert.equal(plan.env.DEEPSEEK_DESKTOP_ENABLED_MCP, undefined);

    const mcpConfig = JSON.parse(readFileSync(plan.env.DEEPSEEK_MCP_CONFIG, "utf8"));
    assert.ok(mcpConfig.servers["desktop-automation"]);
    assert.match(mcpConfig.servers["desktop-automation"].args.join(" "), /desktop-automation-mcp/);
    rmSync(workspace, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

test("automation_create writes an active task, cron file, and managed crontab block", () => {
  const { harness, cleanup } = createHarness();
  const workspace = mkdtempSync(path.join(tmpdir(), "deepseek-tui-workspace-"));
  let writtenCrontab = "";
  try {
    harness.saveApiKey({ provider: "deepseek", apiKey: "test-api-key" });
    harness.crontabRead = () => ({ ok: true, text: "" });
    harness.crontabWrite = (content) => {
      writtenCrontab = content;
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = harness.callAutomationBridgeTool("automation_create", {
      prompt: "检查当前项目并输出简报",
      workspacePath: workspace,
      hour: 9,
      minute: 0,
      timezone: "Asia/Shanghai",
      status: "ACTIVE"
    }, {
      ...defaultSettings(),
      workspacePath: workspace,
      enabledSkills: ["scheduled-task-agent"],
      skillsEnabled: true,
      mcpEnabled: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.task.status, "ACTIVE");
    assert.equal(result.task.installed, true);
    assert.equal(result.task.hour, 9);
    assert.equal(result.task.minute, 0);
    assert.ok(existsSync(result.task.cronPath));
    assert.match(readFileSync(result.task.cronPath, "utf8"), /automation-runner\.cjs/);
    assert.match(writtenCrontab, /BEGIN DeepSeek TUI Desktop automation/);

    const store = harness.readAutomations();
    assert.equal(store.tasks.length, 1);
    assert.equal(store.tasks[0].id, result.task.id);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cleanup();
  }
});

test("generated automation runner is self-contained for max subagent normalization", () => {
  const { harness, cleanup } = createHarness();
  try {
    const runnerPath = harness.writeAutomationRunner();
    const runner = readFileSync(runnerPath, "utf8");

    assert.match(runner, /function normalizeMaxSubagents/);
    assert.match(runner, /DEFAULT_MAX_SUBAGENTS/);
  } finally {
    cleanup();
  }
});
