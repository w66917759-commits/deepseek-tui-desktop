const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTsModule } = require("./loadTsModule.cjs");

test("merges skills, MCP servers, and desktop tools into unified records", () => {
  const { buildCapabilityRecords } = loadTsModule("src/capabilityRegistry.ts");

  const records = buildCapabilityRecords({
    settings: { workspacePath: "/repo", allowShell: true },
    skills: [{
      id: "review",
      name: "Review",
      enabled: true,
      description: "Review code",
      runtimeState: {
        selected: true,
        enabled: true,
        injected: true,
        loaded: true,
        callable: true,
        approvalBlocked: false,
        failed: false,
        state: "callable",
        reason: ""
      }
    }],
    mcpServers: [{
      id: "github",
      name: "GitHub",
      enabled: true,
      connected: false,
      runtimeState: {
        selected: true,
        enabled: true,
        injected: false,
        loaded: false,
        callable: false,
        approvalBlocked: false,
        failed: true,
        state: "failed",
        reason: "missing token"
      }
    }]
  });

  assert.ok(records.some((record) => record.id === "skill:review" && record.kind === "skill"));
  assert.ok(records.some((record) => record.id === "mcp:github" && record.kind === "mcp"));
  assert.ok(records.some((record) => record.id === "desktop:git" && record.kind === "desktop-tool"));
  assert.ok(records.some((record) => record.id === "runtime-api:threads" && record.kind === "runtime-api"));
});

test("keeps selected, injected, callable, and failed states distinct", () => {
  const { buildCapabilityRecords } = loadTsModule("src/capabilityRegistry.ts");

  const records = buildCapabilityRecords({
    settings: { workspacePath: "/repo", allowShell: true },
    mcpServers: [{
      id: "github",
      name: "GitHub",
      enabled: true,
      runtimeState: {
        selected: true,
        enabled: true,
        injected: true,
        loaded: false,
        callable: false,
        approvalBlocked: false,
        failed: true,
        state: "failed",
        reason: "not connected"
      }
    }]
  });
  const github = records.find((record) => record.id === "mcp:github");

  assert.equal(github.runtimeState.selected, true);
  assert.equal(github.runtimeState.injected, true);
  assert.equal(github.runtimeState.callable, false);
  assert.equal(github.runtimeState.failed, true);
  assert.equal(github.reason, "not connected");
});

test("capability context does not declare blocked tools as callable", () => {
  const { buildCapabilityRecords, buildCapabilityContext } = loadTsModule("src/capabilityRegistry.ts");

  const records = buildCapabilityRecords({
    settings: { workspacePath: "/repo", allowShell: false },
    skills: [{
      id: "worker",
      name: "Worker",
      enabled: true,
      runtimeState: {
        selected: true,
        enabled: true,
        injected: true,
        loaded: true,
        callable: true,
        approvalBlocked: false,
        failed: false,
        state: "callable",
        reason: ""
      }
    }],
    mcpServers: [{
      id: "github",
      name: "GitHub",
      enabled: true,
      runtimeState: {
        selected: true,
        enabled: true,
        injected: false,
        loaded: false,
        callable: false,
        approvalBlocked: false,
        failed: false,
        state: "selected",
        reason: "missing token"
      }
    }]
  });
  const context = buildCapabilityContext(records, "en");
  const callableSection = context.split("Blocked selected capabilities:")[0];

  assert.match(callableSection, /Worker \(skill, read-only\)/);
  assert.doesNotMatch(callableSection, /GitHub \(mcp, danger-full-access\)/);
  assert.match(context, /GitHub: selected - missing token/);
  assert.match(context, /Terminal: selected - shell disabled/);
});
