const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTsModule } = require("./loadTsModule.cjs");

function board(overrides = {}) {
  return {
    id: "board",
    sourcePrompt: "implement this plan",
    createdAt: "2026-05-20T00:00:00.000Z",
    model: "deepseek-v4-pro",
    activeSkillIds: ["superpowers"],
    warnings: [],
    items: [
      {
        id: "inspect",
        title: "Inspect",
        goal: "Inspect entry points",
        agentRole: "explorer",
        dependencies: [],
        targetAreas: ["src/App.tsx"],
        acceptance: ["entry points found"],
        status: "draft"
      },
      {
        id: "implement",
        title: "Implement",
        goal: "Implement changes",
        agentRole: "worker",
        dependencies: ["inspect"],
        targetAreas: ["src/App.tsx"],
        acceptance: ["changes implemented"],
        status: "draft"
      }
    ],
    ...overrides
  };
}

function detail(status, extras = {}) {
  return {
    thread: {
      id: "thread-1",
      model: "deepseek-v4-pro",
      mode: "agent",
      updated_at: "2026-05-20T00:02:00.000Z"
    },
    turns: [{
      id: "turn-1",
      thread_id: "thread-1",
      status,
      input_summary: "Inspect",
      created_at: "2026-05-20T00:01:00.000Z",
      started_at: "2026-05-20T00:01:05.000Z",
      ended_at: status === "completed" || status === "failed" ? "2026-05-20T00:02:00.000Z" : null,
      error: status === "failed" ? "boom" : null,
      item_ids: ["item-1"],
      ...extras.turn
    }],
    items: extras.items || [{
      id: "item-1",
      turn_id: "turn-1",
      kind: "agent_message",
      status: "completed",
      summary: "Inspection done",
      detail: "Found App task board execution entry point.",
      started_at: "2026-05-20T00:01:10.000Z",
      ended_at: "2026-05-20T00:02:00.000Z"
    }],
    latest_seq: 1
  };
}

test("schedules downstream tasks only after dependencies complete", () => {
  const { runnableTaskBoardItems, applyTaskRuntimeDetail } = loadTsModule("src/taskRegistry.ts");

  const initialRunnable = runnableTaskBoardItems(board()).map((item) => item.id);
  assert.deepEqual(initialRunnable, ["inspect"]);

  const completed = applyTaskRuntimeDetail(board(), "inspect", detail("completed"));
  const nextRunnable = runnableTaskBoardItems(completed).map((item) => item.id);
  assert.deepEqual(nextRunnable, ["implement"]);
});

test("completed runtime turn marks item completed with output summary", () => {
  const { applyTaskRuntimeDetail } = loadTsModule("src/taskRegistry.ts");

  const updated = applyTaskRuntimeDetail(board(), "inspect", detail("completed"));
  const item = updated.items.find((candidate) => candidate.id === "inspect");

  assert.equal(item.status, "completed");
  assert.equal(item.runtimeThreadId, "thread-1");
  assert.equal(item.runtimeTurnId, "turn-1");
  assert.match(item.outputSummary, /Found App task board/);
  assert.equal(item.completedAt, "2026-05-20T00:02:00.000Z");
});

test("failed and canceled runtime turns mark item failed", () => {
  const { applyTaskRuntimeDetail } = loadTsModule("src/taskRegistry.ts");

  const failed = applyTaskRuntimeDetail(board(), "inspect", detail("failed")).items[0];
  const canceled = applyTaskRuntimeDetail(board(), "inspect", detail("canceled", {
    turn: { error: null, ended_at: "2026-05-20T00:02:00.000Z" }
  })).items[0];

  assert.equal(failed.status, "failed");
  assert.equal(failed.blockedReason, "boom");
  assert.equal(canceled.status, "failed");
  assert.match(canceled.blockedReason, /canceled/);
});

test("dependency failure blocks downstream items with reason", () => {
  const { applyTaskRuntimeDetail } = loadTsModule("src/taskRegistry.ts");

  const updated = applyTaskRuntimeDetail(board(), "inspect", detail("failed"));
  const downstream = updated.items.find((candidate) => candidate.id === "implement");

  assert.equal(downstream.status, "blocked");
  assert.match(downstream.blockedReason, /inspect is failed/);
});

test("old task board data normalizes with draft defaults", () => {
  const { normalizeTaskBoardPlan } = loadTsModule("src/taskRegistry.ts");

  const normalized = normalizeTaskBoardPlan({
    id: "legacy",
    sourcePrompt: "legacy",
    createdAt: "2026-05-20T00:00:00.000Z",
    model: "deepseek-v4-pro",
    activeSkillIds: ["superpowers"],
    warnings: [],
    items: [{
      id: "legacy-task",
      title: "Legacy",
      goal: "Load legacy board",
      agentRole: "worker",
      dependencies: [],
      targetAreas: ["src/App.tsx"],
      acceptance: ["loads"]
    }]
  });

  assert.equal(normalized.items[0].status, "draft");
  assert.equal(normalized.items[0].runtimeThreadId, undefined);
  assert.equal(normalized.items[0].blockedReason, undefined);
});

test("task item prompt includes dependency output and capability context", () => {
  const { applyTaskRuntimeDetail, buildTaskBoardItemExecutionPrompt } = loadTsModule("src/taskRegistry.ts");

  const completed = applyTaskRuntimeDetail(board(), "inspect", detail("completed"));
  const item = completed.items.find((candidate) => candidate.id === "implement");
  const prompt = buildTaskBoardItemExecutionPrompt({
    plan: completed,
    item,
    language: "en",
    capabilityContext: "Callable capabilities:\n- Runtime thread controls"
  });

  assert.match(prompt, /Runtime thread controls/);
  assert.match(prompt, /dependencyOutputs/);
  assert.match(prompt, /Found App task board execution entry point/);
});
