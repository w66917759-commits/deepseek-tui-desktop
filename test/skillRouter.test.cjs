const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTsModule } = require("./loadTsModule.cjs");

function loadSkillRouter() {
  return loadTsModule("src/skillRouter.ts");
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
  assert.equal(decision.routeDebug.primaryIntent, "agentic_planning");
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
    prompt: "/ui-ux-pro-max 检查中文界面翻译",
    settings: { ...baseSettings, skillRoutingMode: "manual" }
  });

  assert.deepEqual(decision.activeSkillIds, ["ui-ux-pro-max"]);
  assert.equal(decision.sanitizedPrompt, "检查中文界面翻译");
  assert.equal(decision.routeDebug.manualOverride, true);
  assert.ok(!decision.rejectedSkills.some((skill) => skill.skillId === "ui-ux-pro-max"));
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
  assert.equal(decision.routeDebug.primaryIntent, "agentic_planning");
});

test("localization review does not route to generic UI skill", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "检查这个项目的中文界面翻译是否准备",
    settings: baseSettings
  });

  assert.deepEqual(decision.intents.map((intent) => intent.id).slice(0, 1), ["localization_review"]);
  assert.ok(decision.activeSkillIds.includes("superpowers"));
  assert.ok(!decision.activeSkillIds.includes("ui-ux-pro-max"));
  assert.ok(decision.rejectedSkills.some((skill) => skill.skillId === "ui-ux-pro-max" && /translation\/localization/.test(skill.reason)));
});

test("direct translation stays lightweight without skills", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "把这段英文翻译成中文",
    settings: baseSettings
  });

  assert.equal(decision.routeDebug.primaryIntent, "translation_chat");
  assert.deepEqual(decision.activeSkillIds, []);
});

test("frontend review routes both UI and review workflow skills", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "检查这个页面 UI/UX 是否合理",
    settings: baseSettings
  });

  assert.equal(decision.routeDebug.primaryIntent, "frontend_review");
  assert.ok(decision.activeSkillIds.includes("ui-ux-pro-max"));
  assert.ok(decision.activeSkillIds.includes("superpowers"));
});

test("routing explanation contains selected candidates and rejected reasons", () => {
  const { routeSkillsForPrompt } = loadSkillRouter();
  const decision = routeSkillsForPrompt({
    prompt: "检查这个项目的中文界面翻译是否准备",
    settings: baseSettings
  });

  assert.match(decision.routeDebug.summary, /localization_review/);
  assert.ok(decision.candidates.some((candidate) => candidate.skillId === "superpowers" && candidate.selected && candidate.score > 0));
  assert.ok(decision.candidates.some((candidate) => candidate.skillId === "ui-ux-pro-max" && candidate.rejectedReasons.length > 0));
});
