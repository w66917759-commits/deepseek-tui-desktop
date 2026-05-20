const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const {
  applyRuntimeThreadEventSnapshot,
  deriveRuntimeCapabilityState,
  extractRuntimeItemParseFailurePath,
  isRuntimeItemPath,
  quarantineMalformedRuntimeItem
} = require("../electron/runtimeApiService.cjs");

function sampleDetail() {
  return {
    thread: {
      id: "thr_demo",
      updated_at: "2026-05-10T00:00:00.000Z"
    },
    turns: [
      {
        id: "turn_demo",
        thread_id: "thr_demo",
        status: "in_progress",
        input_summary: "Build a website",
        item_ids: []
      }
    ],
    items: [],
    latest_seq: 1
  };
}

test("user input runtime events move a thread from waiting to resumed on the same turn", () => {
  const requiredEvent = {
    seq: 2,
    timestamp: "2026-05-10T00:00:01.000Z",
    thread_id: "thr_demo",
    turn_id: "turn_demo",
    item_id: "item_request",
    event: "user_input.required",
    payload: {
      request_id: "req_scaffold",
      turn: {
        id: "turn_demo",
        status: "waiting_user_input"
      },
      item: {
        id: "item_request",
        turn_id: "turn_demo",
        kind: "user_input_request",
        status: "in_progress",
        summary: "Choose a scaffold",
        detail: "Should I use HTML static or Next.js?",
        metadata: {
          request_id: "req_scaffold"
        }
      },
      request: {
        questions: [
          {
            id: "scaffold",
            header: "Scaffold",
            question: "Pick the scaffold",
            options: [
              { label: "HTML static", description: "Simple static site" },
              { label: "Next.js", description: "App router stack" }
            ]
          }
        ]
      }
    }
  };
  const submittedEvent = {
    seq: 3,
    timestamp: "2026-05-10T00:00:02.000Z",
    thread_id: "thr_demo",
    turn_id: "turn_demo",
    item_id: "item_request",
    event: "user_input.submitted",
    payload: {
      request_id: "req_scaffold",
      turn: {
        id: "turn_demo",
        status: "in_progress"
      },
      item: {
        id: "item_request",
        turn_id: "turn_demo",
        kind: "user_input_request",
        status: "completed",
        summary: "Choose a scaffold",
        detail: "Should I use HTML static or Next.js?",
        metadata: {
          request_id: "req_scaffold",
          response: {
            answers: [
              { id: "scaffold", label: "Next.js", value: "Next.js" }
            ]
          }
        }
      }
    }
  };

  const waiting = applyRuntimeThreadEventSnapshot(sampleDetail(), requiredEvent);
  assert.equal(waiting.turns[0].status, "waiting_user_input");
  assert.equal(waiting.items.length, 1);
  assert.equal(waiting.items[0].kind, "user_input_request");
  assert.equal(waiting.items[0].status, "in_progress");
  assert.equal(waiting.latest_seq, 2);

  const resumed = applyRuntimeThreadEventSnapshot(waiting, submittedEvent);
  assert.equal(resumed.turns[0].status, "in_progress");
  assert.equal(resumed.items[0].status, "completed");
  assert.equal(
    resumed.items[0].metadata.response.answers[0].label,
    "Next.js"
  );
  assert.equal(resumed.latest_seq, 3);
});

test("runtime capability state separates selected from callable and keeps failure reasons visible", () => {
  assert.deepEqual(
    deriveRuntimeCapabilityState({
      selected: true,
      enabled: true,
      injected: true,
      loaded: true,
      callable: false,
      failureReason: "Missing API key"
    }),
    {
      selected: true,
      enabled: true,
      injected: true,
      loaded: true,
      callable: false,
      approvalBlocked: false,
      failed: true,
      state: "failed",
      reason: "Missing API key"
    }
  );

  assert.deepEqual(
    deriveRuntimeCapabilityState({
      selected: true,
      enabled: true,
      injected: true,
      loaded: true,
      callable: true,
      approvalBlocked: true
    }),
    {
      selected: true,
      enabled: true,
      injected: true,
      loaded: true,
      callable: true,
      approvalBlocked: true,
      failed: false,
      state: "approval_blocked",
      reason: ""
    }
  );
});

test("runtime item parse repair only accepts task item files and quarantines them", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepseek-runtime-items-"));
  try {
    const itemsDir = path.join(root, "tasks", "runtime", "items");
    mkdirSync(itemsDir, { recursive: true });
    const itemPath = path.join(itemsDir, "item_bad123.json");
    writeFileSync(itemPath, "{\"broken\": true}", "utf8");

    const error = new Error(`Failed to parse ${itemPath}`);
    assert.equal(extractRuntimeItemParseFailurePath(error), itemPath);
    assert.equal(isRuntimeItemPath(itemPath), true);
    assert.equal(isRuntimeItemPath(path.join(root, "tasks", "runtime", "other", "item_bad123.json")), false);
    assert.equal(
      extractRuntimeItemParseFailurePath(new Error(`Failed to parse ${path.join(root, "item_bad123.json")}`)),
      ""
    );

    const result = quarantineMalformedRuntimeItem(itemPath);
    assert.equal(result.source, itemPath);
    assert.equal(existsSync(itemPath), false);
    assert.equal(existsSync(result.target), true);
    assert.equal(path.basename(path.dirname(result.target)), "items.invalid");
    assert.equal(readFileSync(result.target, "utf8"), "{\"broken\": true}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
