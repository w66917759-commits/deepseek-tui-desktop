const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AppServerClient } = require("../electron/appServerClient.cjs");
const { RuntimeOrchestrator } = require("../electron/runtimeOrchestrator.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const RUNTIME_PATH = path.join(
  PROJECT_ROOT,
  "node_modules",
  "deepseek-tui",
  "bin",
  "downloads",
  process.platform === "win32" ? "deepseek.exe" : "deepseek"
);

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

async function runTier(taskCount, t) {
  const root = makeTempRoot(`dstui-stress-${taskCount}`);
  const conversationCount = Math.ceil(taskCount / 2);
  const client = new AppServerClient({
    command: RUNTIME_PATH,
    args: ["app-server", "--stdio"],
    cwd: root,
    requestTimeoutMs: 5_000
  });
  const orchestrator = new RuntimeOrchestrator({ client, maxConcurrentSessions: conversationCount });
  const startedAt = new Map();
  const latencies = [];
  let maxQueueDepth = 0;
  let maxActiveCount = 0;

  t.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.request("app/capabilities", {});
  const rssBefore = process.memoryUsage().rss;

  orchestrator.on("turn-started", (turn) => {
    startedAt.set(turn.turnId, Date.now());
  });
  orchestrator.on("turn-completed", (turn) => {
    const start = startedAt.get(turn.turnId);
    if (start) latencies.push(Date.now() - start);
  });
  orchestrator.on("runtime:snapshot", (snapshot) => {
    if (snapshot.counts.queued > maxQueueDepth) {
      maxQueueDepth = snapshot.counts.queued;
    }
    if (snapshot.activeCount > maxActiveCount) {
      maxActiveCount = snapshot.activeCount;
    }
  });

  for (let index = 0; index < taskCount; index += 1) {
    const conversationIndex = index % conversationCount;
    const workspacePath = path.join(root, `workspace-${conversationIndex}`);
    fs.mkdirSync(workspacePath, { recursive: true });
    orchestrator.startTurn({
      conversationId: `stress-conversation-${conversationIndex}`,
      workspacePath,
      prompt: `stress acceptance task ${index + 1}`
    });
  }

  const snapshot = await orchestrator.waitForIdle({ timeoutMs: 30_000 });
  const rssAfter = process.memoryUsage().rss;
  const failed = snapshot.counts.failed;
  const completed = snapshot.counts.completed;
  const accepted = completed + failed + snapshot.counts.cancelled;
  const report = {
    taskCount,
    conversationCount,
    accepted,
    completed,
    failed,
    p50LatencyMs: percentile(latencies, 0.50),
    p95LatencyMs: percentile(latencies, 0.95),
    maxQueueDepth,
    maxActiveCount,
    rssDeltaBytes: rssAfter - rssBefore,
    appServerCrashed: !client.running
  };

  t.diagnostic(JSON.stringify(report));
  assert.equal(report.accepted, taskCount);
  assert.equal(report.failed, 0);
  assert.equal(report.appServerCrashed, false);
  assert.equal(report.maxActiveCount, conversationCount);

  await Promise.allSettled(
    snapshot.conversations
      .map((conversation) => conversation.threadId)
      .filter(Boolean)
      .map((threadId) => client.request("thread/archive", { thread_id: threadId }, { timeoutMs: 2_000 }))
  );

  return report;
}

test("real app-server session stress accepts 5 and 20 desktop turns", async (t) => {
  if (!fs.existsSync(RUNTIME_PATH)) {
    t.skip("Bundled DeepSeek runtime is not installed.");
    return;
  }

  const reports = [];
  reports.push(await runTier(5, t));
  reports.push(await runTier(20, t));
  assert.equal(reports[0].completed, 5);
  assert.equal(reports[1].completed, 20);
});

test("real app-server session stress accepts 50 desktop turns when explicitly enabled", async (t) => {
  if (!process.env.DEEPSEEK_STRESS_TEST) {
    t.skip("Set DEEPSEEK_STRESS_TEST=1 to run the 50-task stress tier.");
    return;
  }
  if (!fs.existsSync(RUNTIME_PATH)) {
    t.skip("Bundled DeepSeek runtime is not installed.");
    return;
  }

  const report = await runTier(50, t);
  assert.equal(report.completed, 50);
});
