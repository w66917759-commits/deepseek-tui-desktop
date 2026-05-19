const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadSkillRouter() {
  const sourcePath = path.join(__dirname, "..", "src", "skillRouter.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const module = { exports: {} };
  const fn = new Function("exports", "module", "require", outputText);
  fn(module.exports, module, require);
  return module.exports;
}

const baseSettings = {
  skillsEnabled: true,
  skillRoutingMode: "auto",
  enabledSkills: ["superpowers", "ui-ux-pro-max", "scheduled-task-agent", "cron-scheduler", "skill-downloader"]
};

test("scheduled-task prompts route only scheduled-task related skills by default", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "每天 9 点提醒我跑 npm test",
    settings: baseSettings
  });

  assert.deepEqual(decision.activeSkillIds, ["scheduled-task-agent"]);
  assert.match(decision.matches[0].reason, /scheduled/i);
});

test("UI prompts route UI skill and avoid full default injection", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "做一次 UI 优化计划",
    settings: baseSettings
  });

  assert.ok(decision.activeSkillIds.includes("ui-ux-pro-max"));
  assert.ok(decision.activeSkillIds.includes("superpowers"));
  assert.ok(decision.activeSkillIds.length < baseSettings.enabledSkills.length);
});

test("skill install prompts route the skill downloader", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "帮我安装 skill https://example.com/SKILL.md",
    settings: baseSettings
  });

  assert.deepEqual(decision.activeSkillIds, ["skill-downloader"]);
});

test("manual slash routing strips recognized directives", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "/ui-ux-pro-max 优化这个按钮布局",
    settings: { ...baseSettings, skillRoutingMode: "manual" }
  });

  assert.deepEqual(decision.activeSkillIds, ["ui-ux-pro-max"]);
  assert.equal(decision.sanitizedPrompt, "优化这个按钮布局");
});

test("ordinary coding prompts do not inject every default skill", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "修复这个 TypeScript 编译错误",
    settings: baseSettings
  });

  assert.ok(decision.activeSkillIds.includes("superpowers"));
  assert.ok(decision.activeSkillIds.length < baseSettings.enabledSkills.length);
});

test("sub-agent decomposition prompts route to superpowers", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "请拆解成多个子 Agent 并行执行这个重构任务",
    settings: baseSettings
  });

  assert.ok(decision.activeSkillIds.includes("superpowers"));
});
