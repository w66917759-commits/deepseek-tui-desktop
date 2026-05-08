const assert = require("node:assert/strict");
const test = require("node:test");

const { DeepSeekRuntimeState } = require("../electron/runtimeState.cjs");

test("runtime state tracks run lifecycle and terminal-discovered sub-agents", () => {
  const runtimeState = new DeepSeekRuntimeState();
  const events = [];
  runtimeState.on("runtime:event", (event) => events.push(event));

  assert.equal(runtimeState.snapshot().status, "idle");

  runtimeState.startRun({
    sessionId: "session-1",
    mode: "agent",
    workspacePath: "/tmp/workspace",
    pid: 1234,
    command: "deepseek",
    args: ["exec", "--auto", "check status"]
  });

  runtimeState.ingestTerminalData([
    "Sub-agents:",
    "explorer Running Inspecting source files",
    "worker Completed Added focused tests"
  ].join("\n"));

  const snapshot = runtimeState.snapshot();
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.sessionId, "session-1");
  assert.equal(snapshot.mode, "agent");
  assert.equal(snapshot.workspacePath, "/tmp/workspace");
  assert.equal(snapshot.agents.length, 2);
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.id, agent.status, agent.summary]),
    [
      ["explorer", "running", "Inspecting source files"],
      ["worker", "completed", "Added focused tests"]
    ]
  );
  assert.deepEqual(snapshot.counts, {
    total: 2,
    running: 1,
    completed: 1,
    failed: 0,
    cancelled: 0
  });
  assert.equal(events.some((event) => event.type === "agents"), true);

  runtimeState.finishRun({ exitCode: 0 });
  assert.equal(runtimeState.snapshot().status, "completed");
});

test("runtime state accepts structured runtime API events ahead of stable app-server wiring", () => {
  const runtimeState = new DeepSeekRuntimeState();
  runtimeState.startRun({ sessionId: "session-2", mode: "plan", workspacePath: "/tmp/workspace" });

  runtimeState.ingestRuntimeEvent({
    event: "runtime_snapshot",
    agents: [
      { id: "reviewer", name: "Reviewer", status: "running", summary: "Checking the plan" },
      { id: "implementer", name: "Implementer", status: "failed", summary: "Blocked by missing token" }
    ]
  });

  const snapshot = runtimeState.snapshot();
  assert.equal(snapshot.source, "runtime-api");
  assert.equal(snapshot.agents.length, 2);
  assert.equal(snapshot.counts.running, 1);
  assert.equal(snapshot.counts.failed, 1);
});

test("runtime state parses common Superpowers and DeepSeek TUI child-agent terminal formats", () => {
  const runtimeState = new DeepSeekRuntimeState();
  runtimeState.startRun({ sessionId: "session-4", mode: "agent", workspacePath: "/tmp/workspace" });

  runtimeState.ingestTerminalData([
    "Sub-agents:",
    "- explorer: Running - Reading source files",
    "* worker [Completed] Added focused tests",
    "Agent reviewer Failed: Missing token",
    "sub-agent planner queued waiting for scope"
  ].join("\n"));

  const snapshot = runtimeState.snapshot();
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.id, agent.status, agent.summary]),
    [
      ["explorer", "running", "Reading source files"],
      ["worker", "completed", "Added focused tests"],
      ["reviewer", "failed", "Missing token"],
      ["planner", "queued", "waiting for scope"]
    ]
  );
});

test("runtime state stops counting active sub-agents after the parent run exits", () => {
  const runtimeState = new DeepSeekRuntimeState();
  runtimeState.startRun({ sessionId: "session-3", mode: "agent", workspacePath: "/tmp/workspace" });

  runtimeState.ingestRuntimeEvent({
    event: "runtime_snapshot",
    agents: [
      { id: "explorer", name: "Explorer", status: "running", summary: "Reading files" },
      { id: "worker", name: "Worker", status: "queued", summary: "Waiting for scope" },
      { id: "reviewer", name: "Reviewer", status: "completed", summary: "Checked output" }
    ]
  });

  runtimeState.finishRun({ exitCode: 1 });

  const snapshot = runtimeState.snapshot();
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.counts.running, 0);
  assert.equal(snapshot.counts.failed, 0);
  assert.equal(snapshot.counts.cancelled, 2);
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.id, agent.status]),
    [
      ["explorer", "cancelled"],
      ["worker", "cancelled"],
      ["reviewer", "completed"]
    ]
  );
});
