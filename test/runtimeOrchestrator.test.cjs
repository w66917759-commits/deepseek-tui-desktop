const assert = require("node:assert/strict");
const test = require("node:test");
const { RuntimeOrchestrator } = require("../electron/runtimeOrchestrator.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("cancelled turn does not start the runner after thread startup resolves", async () => {
  const startGate = deferred();
  let runnerCalled = false;
  const orchestrator = new RuntimeOrchestrator({
    client: {
      request: async (route) => {
        assert.equal(route, "thread/start");
        await startGate.promise;
        return { thread_id: "thread-cancel-before-runner" };
      }
    },
    runner: async () => {
      runnerCalled = true;
      return new Promise(() => undefined);
    },
    maxConcurrentSessions: 1
  });

  orchestrator.startTurn({
    conversationId: "conversation-cancel-before-runner",
    workspacePath: process.cwd(),
    prompt: "long task"
  });
  const cancelResult = orchestrator.cancelTurn({ conversationId: "conversation-cancel-before-runner" });
  assert.equal(cancelResult.cancelled, 1);

  startGate.resolve();
  const snapshot = await orchestrator.waitForIdle({ timeoutMs: 100 });

  assert.equal(runnerCalled, false);
  assert.equal(snapshot.counts.cancelled, 1);
  assert.equal(snapshot.counts.cancelling, 0);
});

test("cancelled running turn is force-settled when the runner does not exit", async () => {
  let cancelRunnerCalled = false;
  const orchestrator = new RuntimeOrchestrator({
    client: {
      request: async () => ({ thread_id: "thread-stuck-runner" })
    },
    runner: async (turn) => {
      turn.cancelRunner = () => {
        cancelRunnerCalled = true;
      };
      return new Promise(() => undefined);
    },
    cancelGraceMs: 20,
    maxConcurrentSessions: 1
  });

  orchestrator.startTurn({
    conversationId: "conversation-stuck-runner",
    workspacePath: process.cwd(),
    prompt: "stuck task"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const cancelResult = orchestrator.cancelTurn({ conversationId: "conversation-stuck-runner" });
  assert.equal(cancelResult.cancelled, 1);
  assert.equal(cancelRunnerCalled, true);

  const snapshot = await orchestrator.waitForIdle({ timeoutMs: 200 });
  assert.equal(snapshot.counts.cancelled, 1);
  assert.equal(snapshot.counts.cancelling, 0);
  assert.equal(snapshot.activeCount, 0);
});
