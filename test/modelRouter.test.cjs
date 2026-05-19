const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadModelRouter() {
  const sourcePath = path.join(__dirname, "..", "src", "modelRouter.ts");
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

test("simple interactive prompts route to V4 Flash", () => {
  const { routeModelForPrompt } = loadModelRouter();
  const decision = routeModelForPrompt({
    prompt: "解释一下这个函数",
    permissionMode: "agent",
    settings: { provider: "deepseek", model: "deepseek-v4-pro", modelRoutingMode: "auto" },
    activeSkillIds: []
  });

  assert.equal(decision.profile.id, "interactive");
  assert.equal(decision.apiModel, "deepseek-v4-flash");
});

test("planning and review prompts route to V4 Pro", () => {
  const { routeModelForPrompt } = loadModelRouter();
  assert.equal(routeModelForPrompt({
    prompt: "请写一个实现计划",
    permissionMode: "plan",
    settings: { provider: "deepseek", model: "deepseek-v4-flash", modelRoutingMode: "auto" },
    activeSkillIds: []
  }).profile.id, "planner");
  assert.equal(routeModelForPrompt({
    prompt: "review this patch and verify tests",
    permissionMode: "agent",
    settings: { provider: "deepseek", model: "deepseek-v4-flash", modelRoutingMode: "auto" },
    activeSkillIds: []
  }).profile.id, "reviewer");
});

test("scheduled task prompts stay interactive even when command mentions tests", () => {
  const { routeModelForPrompt } = loadModelRouter();
  const decision = routeModelForPrompt({
    prompt: "每天 9 点提醒我跑 npm test",
    permissionMode: "agent",
    settings: { provider: "deepseek", model: "deepseek-v4-pro", modelRoutingMode: "auto" },
    activeSkillIds: ["scheduled-task-agent"]
  });

  assert.equal(decision.profile.id, "interactive");
  assert.equal(decision.apiModel, "deepseek-v4-flash");
});

test("non-DeepSeek custom provider is not auto-selected by DeepSeek profiles", () => {
  const { routeModelForPrompt } = loadModelRouter();
  const decision = routeModelForPrompt({
    prompt: "short answer",
    settings: { provider: "nvidia-nim", model: "custom-model", modelRoutingMode: "auto" },
    activeSkillIds: []
  });

  assert.equal(decision.provider, "nvidia-nim");
  assert.equal(decision.model, "custom-model");
});

test("sub-agent decomposition prompts route to V4 Pro planner profile", () => {
  const { routeModelForPrompt } = loadModelRouter();
  const decision = routeModelForPrompt({
    prompt: "请拆解成多个子 Agent 执行这个复杂实现",
    permissionMode: "agent",
    settings: { provider: "deepseek", model: "deepseek-v4-flash", modelRoutingMode: "auto" },
    activeSkillIds: ["superpowers"]
  });

  assert.equal(decision.profile.id, "planner");
  assert.equal(decision.apiModel, "deepseek-v4-pro");
});
