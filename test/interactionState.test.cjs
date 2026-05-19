const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTsModule(filePath) {
  const source = fs.readFileSync(path.join(__dirname, "..", filePath), "utf8");
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

const { deriveInteractionState } = loadTsModule("src/interactionState.ts");
const nowMs = Date.parse("2026-05-18T08:00:00.000Z");

function baseOptions(overrides = {}) {
  return {
    hasApiKey: true,
    workspacePath: "/repo",
    prompt: "run the task",
    nowMs,
    ...overrides
  };
}

test("blocks submit when the API key is missing", () => {
  const state = deriveInteractionState(baseOptions({ hasApiKey: false }));

  assert.equal(state.phase, "blocked");
  assert.equal(state.reason, "missing_api_key");
  assert.equal(state.canSubmit, false);
});

test("blocks submit when no workspace is selected", () => {
  const state = deriveInteractionState(baseOptions({ workspacePath: "" }));

  assert.equal(state.phase, "blocked");
  assert.equal(state.reason, "missing_workspace");
  assert.equal(state.canSubmit, false);
});

test("shows queued turns before generic running state", () => {
  const state = deriveInteractionState(baseOptions({
    activeRuntimeTurns: [{ status: "queued", queuedAt: "2026-05-18T07:59:30.000Z" }]
  }));

  assert.equal(state.phase, "queued");
  assert.equal(state.canSubmit, false);
  assert.equal(state.canStop, true);
});

test("prefers concrete queued state over launch routing", () => {
  const state = deriveInteractionState(baseOptions({
    statusType: "launching",
    activeRuntimeTurns: [{ status: "queued", queuedAt: "2026-05-18T07:59:30.000Z" }]
  }));

  assert.equal(state.phase, "queued");
});

test("surfaces pending user input from runtime items", () => {
  const state = deriveInteractionState(baseOptions({
    runtimeItems: [{
      kind: "user_input_request",
      status: "in_progress",
      started_at: "2026-05-18T07:59:45.000Z"
    }]
  }));

  assert.equal(state.phase, "waiting_user_input");
  assert.equal(state.reason, "waiting_user_input");
  assert.equal(state.canSubmit, false);
  assert.equal(state.canStop, true);
});

test("ignores completed user input requests", () => {
  const state = deriveInteractionState(baseOptions({
    runtimeItems: [{
      kind: "user_input_request",
      status: "completed",
      started_at: "2026-05-18T07:58:45.000Z",
      ended_at: "2026-05-18T07:59:00.000Z"
    }]
  }));

  assert.equal(state.phase, "ready");
  assert.equal(state.canSubmit, true);
});

test("surfaces pending approvals", () => {
  const state = deriveInteractionState(baseOptions({
    runtimeApiStatus: {
      connected: true,
      state: "connected",
      pendingApprovals: [{ id: "approval-1" }],
      pendingUserInputs: []
    }
  }));

  assert.equal(state.phase, "waiting_approval");
  assert.equal(state.reason, "waiting_approval");
  assert.equal(state.canSubmit, false);
});

test("reports streaming for recent active output", () => {
  const state = deriveInteractionState(baseOptions({
    processStreamEnabled: true,
    runtimeApiTurns: [{
      status: "in_progress",
      started_at: "2026-05-18T07:59:50.000Z"
    }],
    runtimeEvents: [{ at: "2026-05-18T07:59:58.000Z" }]
  }));

  assert.equal(state.phase, "streaming");
  assert.equal(state.stale, false);
  assert.equal(state.canStop, true);
});

test("reports stale running when a long task has no recent activity", () => {
  const state = deriveInteractionState(baseOptions({
    staleAfterMs: 60_000,
    runtimeApiTurns: [{
      status: "in_progress",
      started_at: "2026-05-18T07:55:00.000Z"
    }]
  }));

  assert.equal(state.phase, "stale_running");
  assert.equal(state.stale, true);
  assert.equal(state.canSubmit, false);
});

test("failed status keeps the failure visible but allows retry prompt", () => {
  const state = deriveInteractionState(baseOptions({
    statusType: "error",
    statusMessage: "Runtime crashed"
  }));

  assert.equal(state.phase, "failed");
  assert.equal(state.detail, "Runtime crashed");
  assert.equal(state.canSubmit, true);
});

test("selected but non-callable capability is visible as a warning", () => {
  const state = deriveInteractionState(baseOptions({
    selectedCapabilities: [{
      id: "github",
      enabled: true,
      runtimeState: {
        selected: true,
        callable: false,
        state: "selected",
        reason: "missing token"
      }
    }]
  }));

  assert.equal(state.phase, "ready");
  assert.equal(state.severity, "warning");
  assert.equal(state.capabilityIssue.id, "github");
  assert.equal(state.canSubmit, true);
});

test("empty prompt cannot be submitted even in ready state", () => {
  const state = deriveInteractionState(baseOptions({ prompt: "   " }));

  assert.equal(state.phase, "ready");
  assert.equal(state.canSubmit, false);
});
