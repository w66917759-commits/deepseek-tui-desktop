const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyAgentType,
  normalizeAgentCatalogRecord
} = require("../electron/agentCatalog.cjs");

test("agent catalog classifies known roles", () => {
  assert.equal(classifyAgentType({ name: "code-reviewer" }), "reviewer");
  assert.equal(classifyAgentType({ summary: "Fix TypeScript compiler errors" }), "build-fixer");
  assert.equal(classifyAgentType({ name: "playwright test runner" }), "tester");
  assert.equal(classifyAgentType({ name: "unknown helper" }), "custom");
});

test("runtime events are confirmed and terminal observations are observed", () => {
  assert.equal(normalizeAgentCatalogRecord({ name: "planner" }, "runtime-api").classificationSource, "confirmed");
  assert.equal(normalizeAgentCatalogRecord({ name: "planner" }, "pty").classificationSource, "observed");
});
