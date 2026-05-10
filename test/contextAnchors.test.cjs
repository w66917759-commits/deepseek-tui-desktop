const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadContextAnchorsModule() {
  const sourcePath = path.join(__dirname, "..", "src", "contextAnchors.ts");
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

test("normalizeContextAnchors deduplicates, trims, and keeps the newest anchors", () => {
  const { normalizeContextAnchors } = loadContextAnchorsModule();
  const anchors = normalizeContextAnchors([
    { id: "a1", text: "  Keep the static export path working  ", createdAt: "2026-05-10T00:00:00.000Z" },
    { id: "a2", text: "Keep the static export path working", createdAt: "2026-05-10T00:01:00.000Z" },
    { id: "a3", text: "", createdAt: "2026-05-10T00:02:00.000Z" },
    { id: "a4", text: "Do not break mobile nav", createdAt: "2026-05-10T00:03:00.000Z" }
  ], 2);

  assert.deepEqual(anchors.map((anchor) => anchor.id), ["a2", "a4"]);
  assert.deepEqual(anchors.map((anchor) => anchor.text), [
    "Keep the static export path working",
    "Do not break mobile nav"
  ]);
});

test("buildAnchoredRuntimePrompt prepends saved anchors without changing the visible user message", () => {
  const { buildAnchoredRuntimePrompt } = loadContextAnchorsModule();
  const prompt = buildAnchoredRuntimePrompt(
    "Continue the homepage refactor",
    [
      { id: "a1", text: "The user chose Next.js instead of plain HTML", createdAt: "2026-05-10T00:00:00.000Z" },
      { id: "a2", text: "Keep existing mobile spacing intact", createdAt: "2026-05-10T00:01:00.000Z" }
    ],
    "en"
  );

  assert.match(prompt, /desktop_context_anchors/i);
  assert.match(prompt, /The user chose Next\.js instead of plain HTML/);
  assert.match(prompt, /Keep existing mobile spacing intact/);
  assert.match(prompt, /Continue the homepage refactor/);
});

test("selectContextAnchorDraft prefers the composer text, then the latest user prompt", () => {
  const { selectContextAnchorDraft } = loadContextAnchorsModule();

  assert.equal(
    selectContextAnchorDraft("Pin this exact constraint", "Older prompt", "en"),
    "Pin this exact constraint"
  );
  assert.equal(
    selectContextAnchorDraft("", "Use the existing billing webhook flow", "en"),
    "Use the existing billing webhook flow"
  );
  assert.equal(
    selectContextAnchorDraft("", "", "zh"),
    ""
  );
});

test("deriveContextAnchorTextsFromRuntimeItem turns completed user-input answers into stable anchors", () => {
  const { deriveContextAnchorTextsFromRuntimeItem } = loadContextAnchorsModule();
  const anchors = deriveContextAnchorTextsFromRuntimeItem({
    kind: "user_input_request",
    status: "completed",
    metadata: {
      request: {
        questions: [
          {
            id: "scaffold",
            header: "Scaffold",
            question: "Pick the scaffold",
            options: []
          }
        ]
      },
      response: {
        answers: [
          { id: "scaffold", label: "Next.js", value: "Next.js" }
        ]
      }
    }
  }, "en");

  assert.deepEqual(anchors, ["Confirmed: Scaffold = Next.js"]);
});

test("mergeDerivedContextAnchors appends new decisions once and keeps existing anchors stable", () => {
  const { mergeDerivedContextAnchors } = loadContextAnchorsModule();
  const existing = [
    { id: "a1", text: "Confirmed: Scaffold = Next.js", createdAt: "2026-05-10T00:00:00.000Z" }
  ];

  const merged = mergeDerivedContextAnchors(
    existing,
    [
      "Confirmed: Scaffold = Next.js",
      "Confirmed: Styling = Keep the current spacing scale"
    ],
    {
      createId: (() => {
        let counter = 1;
        return () => `new-${counter++}`;
      })(),
      createdAt: "2026-05-10T00:05:00.000Z"
    }
  );

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((anchor) => anchor.text), [
    "Confirmed: Scaffold = Next.js",
    "Confirmed: Styling = Keep the current spacing scale"
  ]);
  assert.equal(merged[1].id, "new-1");
});

test("deriveContextAnchorTextsFromRuntimeItems collects completed decisions and ignores unfinished prompts", () => {
  const { deriveContextAnchorTextsFromRuntimeItems } = loadContextAnchorsModule();
  const anchors = deriveContextAnchorTextsFromRuntimeItems([
    {
      kind: "user_input_request",
      status: "completed",
      metadata: {
        request: {
          questions: [
            { id: "scaffold", header: "Scaffold", question: "Pick the scaffold", options: [] }
          ]
        },
        response: {
          answers: [
            { id: "scaffold", label: "Next.js", value: "Next.js" }
          ]
        }
      }
    },
    {
      kind: "user_input_request",
      status: "in_progress",
      metadata: {
        request: {
          questions: [
            { id: "styling", header: "Styling", question: "Keep current spacing?", options: [] }
          ]
        },
        response: null
      }
    }
  ], "en");

  assert.deepEqual(anchors, ["Confirmed: Scaffold = Next.js"]);
});
