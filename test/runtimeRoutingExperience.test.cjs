const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadTsModule } = require("./loadTsModule.cjs");

const baseSettings = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  skillsEnabled: true,
  skillRoutingMode: "auto",
  modelRoutingMode: "auto",
  enabledSkills: ["superpowers", "ui-ux-pro-max", "scheduled-task-agent", "cron-scheduler", "skill-downloader"]
};

test("long-task performance and user-interaction prompts route to Pro with agentic and UX skills", () => {
  const { routeSkillsForPrompt } = loadTsModule("src/skillRouter.ts");
  const { routeModelForPrompt } = loadTsModule("src/modelRouter.ts");
  const prompt = "请研究长任务运行时的性能瓶颈，并优化用户交互反馈，避免用户觉得流程卡住。";

  const skillRoute = routeSkillsForPrompt({
    prompt,
    settings: baseSettings
  });
  const modelRoute = routeModelForPrompt({
    prompt: skillRoute.sanitizedPrompt || prompt,
    permissionMode: "agent",
    settings: baseSettings,
    activeSkillIds: skillRoute.activeSkillIds,
    routeIntents: skillRoute.intents
  });

  assert.ok(skillRoute.activeSkillIds.includes("superpowers"));
  assert.ok(skillRoute.activeSkillIds.includes("ui-ux-pro-max"));
  assert.equal(modelRoute.profile.id, "long-horizon");
  assert.equal(modelRoute.apiModel, "deepseek-v4-pro");
});

test("sub-agent decomposition prompts route to task board before execution", () => {
  const { routeSkillsForPrompt } = loadTsModule("src/skillRouter.ts");
  const { routeModelForPrompt } = loadTsModule("src/modelRouter.ts");
  const { shouldCreateTaskBoard, buildTaskBoardExecutionPrompt } = loadTsModule("src/taskDecomposition.ts");
  const prompt = "请拆解成多个子 Agent 执行这个复杂实现，并按依赖关系推进。";

  const skillRoute = routeSkillsForPrompt({
    prompt,
    settings: baseSettings
  });
  const modelRoute = routeModelForPrompt({
    prompt: skillRoute.sanitizedPrompt || prompt,
    permissionMode: "agent",
    settings: baseSettings,
    activeSkillIds: skillRoute.activeSkillIds,
    routeIntents: skillRoute.intents
  });

  assert.ok(skillRoute.activeSkillIds.includes("superpowers"));
  assert.equal(modelRoute.apiModel, "deepseek-v4-pro");
  assert.equal(shouldCreateTaskBoard({
    prompt,
    permissionMode: "agent",
    skillRoutingMode: "auto",
    activeSkillIds: skillRoute.activeSkillIds
  }), true);
  assert.match(buildTaskBoardExecutionPrompt({
    id: "board",
    sourcePrompt: prompt,
    createdAt: new Date().toISOString(),
    model: modelRoute.apiModel,
    activeSkillIds: skillRoute.activeSkillIds,
    items: [{
      id: "implement",
      title: "实现",
      goal: "完成实现",
      agentRole: "worker",
      dependencies: [],
      targetAreas: ["src/App.tsx"],
      acceptance: ["包含任务板 JSON"],
      status: "draft"
    }],
    warnings: []
  }, "zh"), /Task board JSON/);
});

test("task board execution is wired as per-item runtime turns", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");

  assert.match(appSource, /buildTaskBoardItemExecutionPrompt/);
  assert.match(appSource, /createRuntimeApiThread/);
  assert.match(appSource, /startRuntimeApiThreadTurn/);
  assert.doesNotMatch(appSource, /buildTaskBoardExecutionPrompt\(options\.taskBoard/);
});

test("localization review route flows into runtime settings without UI skill", () => {
  const { routeSkillsForPrompt } = loadTsModule("src/skillRouter.ts");
  const { routeModelForPrompt } = loadTsModule("src/modelRouter.ts");
  const prompt = "检查这个项目的中文界面翻译是否准备";

  const skillRoute = routeSkillsForPrompt({
    prompt,
    settings: baseSettings
  });
  const modelRoute = routeModelForPrompt({
    prompt: skillRoute.sanitizedPrompt || prompt,
    permissionMode: "agent",
    settings: baseSettings,
    activeSkillIds: skillRoute.activeSkillIds,
    routeIntents: skillRoute.intents
  });
  const runtimeSettings = {
    ...baseSettings,
    enabledSkills: skillRoute.activeSkillIds,
    model: modelRoute.apiModel,
    provider: modelRoute.provider
  };

  assert.equal(skillRoute.routeDebug.primaryIntent, "localization_review");
  assert.deepEqual(runtimeSettings.enabledSkills, ["superpowers"]);
  assert.equal(modelRoute.profile.id, "reviewer");
  assert.equal(runtimeSettings.model, "deepseek-v4-pro");
});
