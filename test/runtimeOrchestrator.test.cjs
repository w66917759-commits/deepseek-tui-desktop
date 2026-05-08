const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RuntimeOrchestrator, createDeepSeekCliRunner } = require("../electron/runtimeOrchestrator.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAppServerClient {
  constructor() {
    this.threadSequence = 0;
    this.calls = [];
    this.messages = [];
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      this.threadSequence += 1;
      const threadId = `thread-${this.threadSequence}`;
      return {
        thread_id: threadId,
        status: "started",
        thread: {
          id: threadId,
          cwd: params.cwd,
          status: "running"
        },
        events: []
      };
    }
    if (method === "thread/message") {
      const item = { params, deferred: deferred() };
      this.messages.push(item);
      return item.deferred.promise;
    }
    if (method === "thread/archive") {
      return { thread_id: params.thread_id, status: "archived", events: [] };
    }
    return { ok: true, events: [] };
  }

  pendingInputs() {
    return this.messages.map((item) => item.params.input);
  }

  resolveMessage(item, delta = "ok") {
    item.deferred.resolve({
      thread_id: item.params.thread_id,
      status: "accepted",
      events: [
        { event: "response_start", response_id: `${item.params.thread_id}:1` },
        { event: "response_delta", response_id: `${item.params.thread_id}:1`, delta },
        { event: "response_end", response_id: `${item.params.thread_id}:1` }
      ],
      data: {}
    });
    return item.params;
  }

  resolveNext(delta = "ok") {
    const item = this.messages.shift();
    assert.ok(item, "expected a pending message");
    return this.resolveMessage(item, delta);
  }

  resolveByInput(input, delta = `${input} done`) {
    const index = this.messages.findIndex((item) => item.params.input === input);
    assert.notEqual(index, -1, `expected pending message for input: ${input}`);
    const [item] = this.messages.splice(index, 1);
    return this.resolveMessage(item, delta);
  }
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("deepseek cli runner uses supplied harness launch args", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dstui-runner-args-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, "print-args.cjs");
  fs.writeFileSync(scriptPath, [
    "process.stdout.write(JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  env: {",
    "    DEEPSEEK_SKILLS_DIR: process.env.DEEPSEEK_SKILLS_DIR || '',",
    "    DEEPSEEK_MCP_CONFIG: process.env.DEEPSEEK_MCP_CONFIG || ''",
    "  }",
    "}));"
  ].join("\n"));

  const runner = createDeepSeekCliRunner({
    command: process.execPath,
    args: [scriptPath, "exec", "--enable", "mcp", "--auto", "Ping"],
    cwd: root,
    env: {
      DEEPSEEK_SKILLS_DIR: path.join(root, "skills"),
      DEEPSEEK_MCP_CONFIG: path.join(root, "mcp.json")
    }
  });
  const result = await runner(
    { turnId: "turn-1", prompt: "SHOULD_NOT_REBUILD_ARGS" },
    { workspacePath: root },
    () => undefined
  );
  const payload = JSON.parse(result.output);

  assert.deepEqual(payload.args, ["exec", "--enable", "mcp", "--auto", "Ping"]);
  assert.equal(payload.cwd, root);
  assert.equal(payload.env.DEEPSEEK_SKILLS_DIR, path.join(root, "skills"));
  assert.equal(payload.env.DEEPSEEK_MCP_CONFIG, path.join(root, "mcp.json"));
});

test("runtime orchestrator queues within each conversation and runs conversations in background", async () => {
  const client = new FakeAppServerClient();
  const orchestrator = new RuntimeOrchestrator({ client, maxConcurrentSessions: 4 });

  const turns = [];
  for (let round = 0; round < 5; round += 1) {
    for (let conversationIndex = 0; conversationIndex < 4; conversationIndex += 1) {
      turns.push(orchestrator.startTurn({
        conversationId: `conversation-${conversationIndex}`,
        workspacePath: `/tmp/workspace-${conversationIndex}`,
        prompt: `conversation-${conversationIndex} task-${round + 1}`
      }));
    }
  }
  await settle();

  let snapshot = orchestrator.snapshot();
  assert.equal(turns.length, 20);
  assert.equal(snapshot.maxConcurrent, 4);
  assert.equal(snapshot.counts.running, 4);
  assert.equal(snapshot.counts.queued, 16);
  assert.equal(client.messages.length, 4);
  assert.deepEqual(client.pendingInputs(), [
    "conversation-0 task-1",
    "conversation-1 task-1",
    "conversation-2 task-1",
    "conversation-3 task-1"
  ]);

  for (let round = 0; round < 5; round += 1) {
    for (let conversationIndex = 0; conversationIndex < 4; conversationIndex += 1) {
      client.resolveByInput(`conversation-${conversationIndex} task-${round + 1}`);
    }
    await settle();
  }
  await orchestrator.waitForIdle({ timeoutMs: 1_000 });

  snapshot = orchestrator.snapshot();
  assert.equal(snapshot.counts.running, 0);
  assert.equal(snapshot.counts.queued, 0);
  assert.equal(snapshot.counts.completed, 20);
  assert.equal(snapshot.counts.failed, 0);
});

test("runtime orchestrator starts another conversation while the current conversation has a queued turn", async () => {
  const client = new FakeAppServerClient();
  const orchestrator = new RuntimeOrchestrator({ client, maxConcurrentSessions: 2 });

  const a1 = orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a1" });
  const a2 = orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a2" });
  const b1 = orchestrator.startTurn({ conversationId: "b", workspacePath: "/tmp/b", prompt: "b1" });
  await settle();

  assert.equal(a1.queued, false);
  assert.equal(a2.queued, true);
  assert.equal(b1.queued, false);
  assert.deepEqual(client.pendingInputs(), ["a1", "b1"]);

  let snapshot = orchestrator.snapshot();
  assert.equal(snapshot.counts.running, 2);
  assert.equal(snapshot.counts.queued, 1);
  assert.equal(snapshot.turns.find((turn) => turn.turnId === a2.turnId).queuePosition, 1);

  client.resolveByInput("a1", "a1 done");
  await settle();

  snapshot = orchestrator.snapshot();
  assert.deepEqual(client.pendingInputs(), ["b1", "a2"]);
  assert.equal(snapshot.turns.find((turn) => turn.turnId === a2.turnId).status, "running");

  client.resolveByInput("b1", "b1 done");
  client.resolveByInput("a2", "a2 done");
  await orchestrator.waitForIdle({ timeoutMs: 1_000 });
});

test("runtime orchestrator uses the CLI runner for model turns instead of thread/message ACKs", async () => {
  const client = new FakeAppServerClient();
  const runnerCalls = [];
  const pendingRuns = [];
  const runner = (turn, conversation, emitEvent) => {
    runnerCalls.push({ turn, conversation });
    const run = deferred();
    pendingRuns.push({ turn, conversation, emitEvent, run });
    return run.promise;
  };
  const orchestrator = new RuntimeOrchestrator({ client, runner, maxConcurrentSessions: 2 });

  const a1 = orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a1", model: "deepseek-v4-flash" });
  const a2 = orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a2", model: "deepseek-v4-flash" });
  const b1 = orchestrator.startTurn({ conversationId: "b", workspacePath: "/tmp/b", prompt: "b1", model: "deepseek-v4-flash" });
  await settle();

  assert.equal(a1.queued, false);
  assert.equal(a2.queued, true);
  assert.equal(b1.queued, false);
  assert.equal(runnerCalls.length, 2);
  assert.deepEqual(runnerCalls.map((call) => call.turn.prompt), ["a1", "b1"]);
  assert.equal(client.calls.some((call) => call.method === "thread/message"), false);

  pendingRuns[0].emitEvent({ event: "response_delta", delta: "queued" });
  pendingRuns[0].emitEvent({ event: "response_delta", delta: "real answer" });
  pendingRuns[0].run.resolve({ output: "real answer" });
  await settle();

  let snapshot = orchestrator.snapshot();
  assert.equal(snapshot.turns.find((turn) => turn.turnId === a1.turnId).output, "real answer");
  assert.equal(snapshot.turns.find((turn) => turn.turnId === a1.turnId).status, "completed");
  assert.equal(snapshot.turns.find((turn) => turn.turnId === a2.turnId).status, "running");
  assert.equal(runnerCalls.length, 3);
  assert.deepEqual(runnerCalls.map((call) => call.turn.prompt), ["a1", "b1", "a2"]);

  pendingRuns[1].run.resolve({ output: "b done" });
  pendingRuns[2].run.resolve({ output: "a2 done" });
  await orchestrator.waitForIdle({ timeoutMs: 1_000 });
  snapshot = orchestrator.snapshot();
  assert.equal(snapshot.counts.completed, 3);
});

test("runtime orchestrator does not let a busy conversation block an idle conversation", async () => {
  const client = new FakeAppServerClient();
  const orchestrator = new RuntimeOrchestrator({ client, maxConcurrentSessions: 2 });

  orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a1" });
  orchestrator.startTurn({ conversationId: "b", workspacePath: "/tmp/b", prompt: "b1" });
  orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a2" });
  orchestrator.startTurn({ conversationId: "c", workspacePath: "/tmp/c", prompt: "c1" });
  await settle();

  assert.deepEqual(client.pendingInputs(), ["a1", "b1"]);

  client.resolveByInput("b1", "b1 done");
  await settle();

  assert.deepEqual(client.pendingInputs(), ["a1", "c1"]);

  client.resolveByInput("a1", "a1 done");
  await settle();

  assert.deepEqual(client.pendingInputs(), ["c1", "a2"]);
  client.resolveByInput("c1", "c1 done");
  client.resolveByInput("a2", "a2 done");
  await orchestrator.waitForIdle({ timeoutMs: 1_000 });
});

test("runtime orchestrator cancellation only affects the requested conversation", async () => {
  const client = new FakeAppServerClient();
  const orchestrator = new RuntimeOrchestrator({ client, maxConcurrentSessions: 2 });

  orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a1" });
  const queuedA = orchestrator.startTurn({ conversationId: "a", workspacePath: "/tmp/a", prompt: "a2" });
  const runningB = orchestrator.startTurn({ conversationId: "b", workspacePath: "/tmp/b", prompt: "b1" });
  await settle();

  const cancel = orchestrator.cancelTurn({ conversationId: "a" });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.cancelled, 2);

  let snapshot = orchestrator.snapshot();
  assert.equal(snapshot.counts.cancelling, 1);
  assert.equal(snapshot.counts.cancelled, 1);
  assert.equal(snapshot.counts.running, 1);
  assert.equal(snapshot.turns.find((turn) => turn.turnId === queuedA.turnId).status, "cancelled");
  assert.equal(snapshot.turns.find((turn) => turn.turnId === runningB.turnId).status, "running");

  client.resolveByInput("a1", "a1 done");
  await settle();
  snapshot = orchestrator.snapshot();
  assert.equal(snapshot.counts.cancelled, 2);
  assert.equal(snapshot.turns.find((turn) => turn.turnId === runningB.turnId).status, "running");

  client.resolveByInput("b1", "b1 done");
  await orchestrator.waitForIdle({ timeoutMs: 1_000 });
  snapshot = orchestrator.snapshot();
  assert.equal(snapshot.counts.completed, 1);
  assert.equal(snapshot.counts.cancelled, 2);
  assert.equal(snapshot.turns.find((turn) => turn.turnId === runningB.turnId).status, "completed");
});
