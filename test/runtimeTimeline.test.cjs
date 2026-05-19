const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTsModule(relativePath, extra = {}) {
  const sourcePath = path.join(__dirname, "..", relativePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const module = { exports: {} };
  const localRequire = (id) => {
    if (extra[id]) return extra[id];
    return require(id);
  };
  const fn = new Function("exports", "module", "require", outputText);
  fn(module.exports, module, localRequire);
  return module.exports;
}

test("runtime timeline separates final answer from tools and raw items", () => {
  const runtimeConversation = loadTsModule("src/runtimeConversation.ts");
  const { buildRuntimeTimeline } = loadTsModule("src/runtimeTimeline.ts", {
    "./runtimeConversation": runtimeConversation
  });
  const timeline = buildRuntimeTimeline({
    turns: [{
      item_ids: ["user", "tool", "status", "answer", "question", "approval", "error"]
    }],
    items: [
      { id: "user", kind: "user_message", detail: "Build the app" },
      { id: "tool", kind: "tool_call", detail: "npm test" },
      { id: "status", kind: "status", detail: "Running checks" },
      { id: "answer", kind: "agent_message", detail: "Implemented and verified." },
      { id: "question", kind: "user_input_request", status: "in_progress", detail: "Choose an option" },
      { id: "approval", kind: "approval_request", status: "in_progress", detail: "Allow shell" },
      { id: "error", kind: "error", detail: "Build failed" }
    ]
  });

  assert.deepEqual(timeline.finalAnswer.map((entry) => entry.text), ["Implemented and verified."]);
  assert.deepEqual(timeline.toolCalls.map((entry) => entry.text), ["npm test"]);
  assert.deepEqual(timeline.actions.map((entry) => entry.text), ["Running checks"]);
  assert.deepEqual(timeline.questions.map((entry) => entry.text), ["Choose an option"]);
  assert.deepEqual(timeline.approvals.map((entry) => entry.text), ["Allow shell"]);
  assert.deepEqual(timeline.errors.map((entry) => entry.text), ["Build failed"]);
  assert.deepEqual(
    timeline.mainEntries.map((entry) => entry.id),
    ["user", "answer", "question", "approval", "error"]
  );
});
