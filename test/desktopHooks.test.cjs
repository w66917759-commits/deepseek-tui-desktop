const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadHooks() {
  const sourcePath = path.join(__dirname, "..", "src", "desktopHooks.ts");
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

test("desktop hook events are append-only and capped", () => {
  const { appendDesktopHookEvent } = loadHooks();
  let events = [];
  events = appendDesktopHookEvent(events, "beforePromptRoute", "before", { prompt: "one" }, 2);
  events = appendDesktopHookEvent(events, "afterSkillRoute", "skills", { skills: ["superpowers"] }, 2);
  events = appendDesktopHookEvent(events, "afterTurnComplete", "done", {}, 2);

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.name), ["afterSkillRoute", "afterTurnComplete"]);
  assert.equal(events[0].payload.skills[0], "superpowers");
});
