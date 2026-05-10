const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadRuntimeConversationModule() {
  const sourcePath = path.join(__dirname, "..", "src", "runtimeConversation.ts");
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

test("appendRuntimePromptMessages keeps the prompt visible while waiting for runtime items", () => {
  const { appendRuntimePromptMessages } = loadRuntimeConversationModule();
  let counter = 0;
  const messages = appendRuntimePromptMessages(
    [{ id: "welcome", role: "assistant", content: "Welcome" }],
    "Build a site",
    "zh",
    () => `msg-${++counter}`
  );

  assert.equal(messages.length, 3);
  assert.deepEqual(messages.slice(1).map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[1].content, "Build a site");
  assert.match(messages[2].content, /等待运行时回复/);
});

test("shouldRenderRuntimeConversation falls back to stored chat messages until runtime items exist", () => {
  const { shouldRenderRuntimeConversation } = loadRuntimeConversationModule();

  assert.equal(
    shouldRenderRuntimeConversation({
      thread: { id: "thr_demo" },
      turns: [{ id: "turn_demo", item_ids: [] }],
      items: [],
      latest_seq: 1
    }),
    false
  );

  assert.equal(
    shouldRenderRuntimeConversation({
      thread: { id: "thr_demo" },
      turns: [{ id: "turn_demo", item_ids: ["item_user"] }],
      items: [{ id: "item_user", kind: "user_message" }],
      latest_seq: 2
    }),
    true
  );
});

test("orderedRuntimeConversationItems follows turn item_ids before loose items", () => {
  const { orderedRuntimeConversationItems } = loadRuntimeConversationModule();
  const ordered = orderedRuntimeConversationItems({
    turns: [
      { item_ids: ["item_user", "item_agent"] }
    ],
    items: [
      { id: "item_agent", kind: "agent_message" },
      { id: "item_status", kind: "status" },
      { id: "item_user", kind: "user_message" }
    ]
  });

  assert.deepEqual(
    ordered.map((item) => item.id),
    ["item_user", "item_agent", "item_status"]
  );
});

test("conversationMessagesFromRuntimeDetail extracts visible user and assistant transcript items", () => {
  const { conversationMessagesFromRuntimeDetail } = loadRuntimeConversationModule();
  const messages = conversationMessagesFromRuntimeDetail({
    turns: [{ item_ids: ["item_user", "item_agent", "item_tool"] }],
    items: [
      { id: "item_user", kind: "user_message", detail: "Build a site" },
      { id: "item_agent", kind: "agent_message", detail: "Use Next.js." },
      { id: "item_tool", kind: "tool_call", detail: "npm create next-app" }
    ]
  });

  assert.deepEqual(messages, [
    { id: "item_user", role: "user", content: "Build a site" },
    { id: "item_agent", role: "assistant", content: "Use Next.js." }
  ]);
});

test("summarizeRuntimeContextHealth surfaces seams, compactions, and pending inputs", () => {
  const { summarizeRuntimeContextHealth } = loadRuntimeConversationModule();
  const summary = summarizeRuntimeContextHealth({
    thread: { id: "thr_demo" },
    turns: [
      { id: "turn_1", status: "completed", item_ids: ["item_user_1", "item_seam", "item_compact"] },
      { id: "turn_2", status: "waiting_user_input", item_ids: ["item_user_2", "item_question", "item_approval"] }
    ],
    items: [
      { id: "item_user_1", kind: "user_message", detail: "Initial request" },
      { id: "item_seam", kind: "status", detail: "L1 seam complete (1 total, 24 messages covered)" },
      { id: "item_compact", kind: "context_compaction", detail: "auto compact done" },
      { id: "item_user_2", kind: "user_message", detail: "Refine the landing page" },
      { id: "item_question", kind: "user_input_request", status: "in_progress", detail: "Choose HTML static or Next.js" },
      { id: "item_approval", kind: "approval_request", status: "in_progress", detail: "Run npm install" }
    ],
    latest_seq: 9
  }, true);

  assert.equal(summary.layeredContextEnabled, true);
  assert.equal(summary.latestTurnStatus, "waiting_user_input");
  assert.equal(summary.latestUserPrompt, "Refine the landing page");
  assert.equal(summary.seamCount, 1);
  assert.equal(summary.compactionCount, 1);
  assert.equal(summary.pendingUserInputs, 1);
  assert.equal(summary.pendingApprovals, 1);
  assert.equal(summary.recallAvailable, true);
});

test("buildRecallArchivePrompt asks the runtime to use archive recall for a focused topic", () => {
  const { buildRecallArchivePrompt } = loadRuntimeConversationModule();
  const prompt = buildRecallArchivePrompt("landing page pricing decision", "en");

  assert.match(prompt, /recall_archive/);
  assert.match(prompt, /landing page pricing decision/);
  assert.match(prompt, /decisions, constraints, files, and failed approaches/i);
});
