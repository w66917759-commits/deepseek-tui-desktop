const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTaskDecomposition() {
  const sourcePath = path.join(__dirname, "..", "src", "taskDecomposition.ts");
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

const metadata = {
  sourcePrompt: "请拆解成多个子 Agent 执行",
  model: "deepseek-v4-pro",
  activeSkillIds: ["superpowers"]
};

test("parses fenced task board JSON into a persisted plan", () => {
  const { parseTaskBoardPlan } = loadTaskDecomposition();
  const result = parseTaskBoardPlan(`\`\`\`json
{
  "items": [
    {
      "id": "inspect",
      "title": "检查入口",
      "goal": "确认现有任务路由入口",
      "agentRole": "explorer",
      "dependencies": [],
      "targetAreas": ["src/App.tsx"],
      "acceptance": ["定位发送流程"],
      "status": "draft"
    }
  ],
  "warnings": ["保持 runtime 边界"]
}
\`\`\``, metadata);

  assert.equal(result.ok, true);
  assert.equal(result.plan.items[0].agentRole, "explorer");
  assert.equal(result.plan.items[0].status, "draft");
  assert.deepEqual(result.plan.warnings, ["保持 runtime 边界"]);
});

test("rejects malformed JSON and missing required item fields", () => {
  const { parseTaskBoardPlan } = loadTaskDecomposition();
  assert.equal(parseTaskBoardPlan("not json", metadata).ok, false);
  const missing = parseTaskBoardPlan(JSON.stringify({
    items: [{
      id: "broken",
      title: "Broken",
      agentRole: "worker",
      targetAreas: ["src/App.tsx"],
      acceptance: ["done"]
    }]
  }), metadata);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing required fields/i);
});

test("complex sub-agent prompts trigger task board generation but manual routing does not", () => {
  const { shouldCreateTaskBoard } = loadTaskDecomposition();
  assert.equal(shouldCreateTaskBoard({
    prompt: "请拆解成多个子 Agent 并行执行",
    skillRoutingMode: "auto",
    activeSkillIds: ["superpowers"]
  }), true);
  assert.equal(shouldCreateTaskBoard({
    prompt: "请拆解成多个子 Agent 并行执行",
    skillRoutingMode: "manual",
    activeSkillIds: ["superpowers"]
  }), false);
  assert.equal(shouldCreateTaskBoard({
    prompt: "解释一下这个函数",
    skillRoutingMode: "auto",
    activeSkillIds: []
  }), false);
});

test("execution prompt carries original task and task board constraints", () => {
  const { buildTaskBoardExecutionPrompt, parseTaskBoardPlan } = loadTaskDecomposition();
  const result = parseTaskBoardPlan(JSON.stringify({
    items: [{
      id: "implement",
      title: "实现任务板",
      goal: "接入任务板执行 prompt",
      agentRole: "worker",
      dependencies: [],
      targetAreas: ["src/App.tsx"],
      acceptance: ["最终 prompt 包含任务板 JSON"]
    }],
    warnings: []
  }), metadata);
  assert.equal(result.ok, true);
  const prompt = buildTaskBoardExecutionPrompt(result.plan, "zh");
  assert.match(prompt, /Original user request/);
  assert.match(prompt, /请拆解成多个子 Agent 执行/);
  assert.match(prompt, /Task board JSON/);
  assert.match(prompt, /实现任务板/);
});

test("parser preserves task registry fields for compatibility", () => {
  const { parseTaskBoardPlan } = loadTaskDecomposition();
  const result = parseTaskBoardPlan(JSON.stringify({
    items: [{
      id: "implement",
      title: "实现任务板",
      goal: "接入任务板执行 prompt",
      agentRole: "worker",
      dependencies: [],
      targetAreas: ["src/App.tsx"],
      acceptance: ["最终 prompt 包含任务板 JSON"],
      status: "running",
      runId: "run-1",
      runtimeThreadId: "thread-1",
      runtimeTurnId: "turn-1",
      blockedReason: "waiting",
      outputSummary: "partial output",
      lastActivityAt: "2026-05-20T00:00:00.000Z",
      completedAt: "2026-05-20T00:01:00.000Z"
    }],
    warnings: []
  }), metadata);

  assert.equal(result.ok, true);
  assert.equal(result.plan.items[0].runId, "run-1");
  assert.equal(result.plan.items[0].runtimeThreadId, "thread-1");
  assert.equal(result.plan.items[0].outputSummary, "partial output");
});

test("decomposition prompt carries capability summary", () => {
  const { buildTaskDecompositionPrompt } = loadTaskDecomposition();
  const prompt = buildTaskDecompositionPrompt({
    sourcePrompt: "拆解任务",
    model: "deepseek-v4-pro",
    activeSkillIds: ["superpowers"],
    maxSubagents: 5,
    language: "zh",
    capabilityContext: "能力上下文：只把 callable 能力视为可用。"
  });

  assert.match(prompt, /能力上下文/);
  assert.match(prompt, /Original user request/);
});

test("runtime status mapping does not mark unmatched items complete", () => {
  const { applyRuntimeStatusToTaskBoard, parseTaskBoardPlan } = loadTaskDecomposition();
  const result = parseTaskBoardPlan(JSON.stringify({
    items: [
      {
        id: "inspect",
        title: "检查入口",
        goal: "确认入口",
        agentRole: "explorer",
        dependencies: [],
        targetAreas: ["src/App.tsx"],
        acceptance: ["完成检查"]
      },
      {
        id: "implement",
        title: "实现任务板",
        goal: "写代码",
        agentRole: "worker",
        dependencies: ["inspect"],
        targetAreas: ["src/App.tsx"],
        acceptance: ["完成实现"]
      }
    ],
    warnings: []
  }), metadata);
  assert.equal(result.ok, true);
  const updated = applyRuntimeStatusToTaskBoard(result.plan, [], [{
    turnId: "turn",
    conversationId: "session",
    threadId: "thread",
    status: "running",
    prompt: "run",
    output: "",
    error: "",
    queuedAt: "",
    startedAt: "",
    completedAt: "",
    replyMessageId: "",
    queuePosition: 0
  }]);
  assert.equal(updated.items.some((item) => item.status === "completed"), false);
  assert.ok(updated.items.some((item) => item.status === "running"));
});
