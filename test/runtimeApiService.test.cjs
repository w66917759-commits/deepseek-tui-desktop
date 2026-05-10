const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyRuntimeThreadEventSnapshot,
  deriveRuntimeCapabilityState
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
