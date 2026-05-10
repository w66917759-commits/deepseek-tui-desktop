const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadDesktopApiModule() {
  const sourcePath = path.join(__dirname, "..", "src", "desktopApi.ts");
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

test("preview runtime thread turn resolves before its synthetic thread event is published", async () => {
  const { createPreviewBridge } = loadDesktopApiModule();
  const desktop = createPreviewBridge();
  const events = [];
  const off = desktop.onRuntimeApiThreadEvent((event) => {
    events.push(event);
  });

  const result = await desktop.startRuntimeApiThreadTurn({
    prompt: "Build a website",
    workspacePath: "/Users/west/project"
  });

  assert.equal(result.ok, true);
  assert.equal(events.length, 0);
  assert.equal(result.detail?.items?.length, 2);
  assert.deepEqual(
    result.detail?.items?.map((item) => item.kind),
    ["user_message", "agent_message"]
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  off();

  assert.equal(events.length, 1);
  assert.equal(events[0].event.event, "turn.completed");
  assert.equal(events[0].detail.items.length, 2);
});
