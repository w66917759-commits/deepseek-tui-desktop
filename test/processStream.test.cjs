const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadProcessStreamModule() {
  const sourcePath = path.join(__dirname, "..", "src", "processStream.ts");
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

test("streams raw process output without filtering code blocks or patches", () => {
  const { formatProcessStreamOutput } = loadProcessStreamModule();
  const output = [
    "\u001b[32mthinking\u001b[0m done · 1.3s",
    "The user wants the desktop stream to stay raw.",
    "```tsx",
    "export function FullComponent() {",
    "  return <main>{veryLargeSource}</main>;",
    "}",
    "```",
    "diff --git a/src/App.tsx b/src/App.tsx",
    "@@ -1,3 +1,8 @@",
    "+const leakedSource = true;",
    "▶ run npm test",
    "Tests passed."
  ].join("\n");

  const formatted = formatProcessStreamOutput(output);

  assert.equal(formatted, output);
  assert.match(formatted, /FullComponent/);
  assert.match(formatted, /leakedSource/);
  assert.match(formatted, /diff --git/);
  assert.match(formatted, /\u001b\[32mthinking/);
});

test("main conversation fallback is not capped to the final excerpt", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");

  assert.doesNotMatch(appSource, /lines\.slice\(-28\)/);
  assert.doesNotMatch(appSource, /useful\.slice\(-2400\)/);
  assert.doesNotMatch(appSource, /summarizeProcessStreamOutput/);
});

test("normalizes DeepSeek thinking modes with max as the default", () => {
  const { normalizeDeepSeekThinkingMode } = loadProcessStreamModule();

  assert.equal(normalizeDeepSeekThinkingMode("max"), "max");
  assert.equal(normalizeDeepSeekThinkingMode("high"), "high");
  assert.equal(normalizeDeepSeekThinkingMode("off"), "off");
  assert.equal(normalizeDeepSeekThinkingMode(""), "max");
  assert.equal(normalizeDeepSeekThinkingMode("medium"), "max");
});

test("runtime reasoning effort follows the selected thinking mode", () => {
  const { desktopProcessReasoningEffort } = require("../electron/harness.cjs");

  assert.equal(desktopProcessReasoningEffort({ processStreamEnabled: true, thinkingMode: "max" }), "max");
  assert.equal(desktopProcessReasoningEffort({ processStreamEnabled: true, thinkingMode: "high" }), "high");
  assert.equal(desktopProcessReasoningEffort({ processStreamEnabled: true, thinkingMode: "off" }), "off");
  assert.equal(desktopProcessReasoningEffort({ processStreamEnabled: false, thinkingMode: "max" }), "off");
  assert.equal(desktopProcessReasoningEffort({ processStreamEnabled: true }), "max");
});

test("runtime stream output accepts orchestrator detail events", () => {
  const { runtimeTurnOutputChunk } = loadProcessStreamModule();

  assert.equal(runtimeTurnOutputChunk({ type: "response_delta", detail: "raw stream" }), "raw stream");
  assert.equal(runtimeTurnOutputChunk({ event: "response_delta", delta: "raw delta" }), "raw delta");
  assert.equal(runtimeTurnOutputChunk({ type: "runtime_stderr", detail: "stderr stream" }), "stderr stream");
  assert.equal(runtimeTurnOutputChunk({ event: "runtime_stderr", message: "stderr message" }), "stderr message");
  assert.equal(runtimeTurnOutputChunk({ type: "turn-completed", detail: "final event" }), "");
});
