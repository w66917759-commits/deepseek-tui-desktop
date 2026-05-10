const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DeepSeekDesktopHarness, defaultSettings } = require("../electron/harness.cjs");

function createHarness() {
  const userData = mkdtempSync(path.join(tmpdir(), "deepseek-tui-desktop-test-"));
  const app = {
    getPath(name) {
      if (name !== "userData") throw new Error(`Unexpected app path ${name}`);
      return userData;
    },
    getAppPath() {
      return path.join(__dirname, "..");
    }
  };
  return {
    harness: new DeepSeekDesktopHarness(app),
    cleanup() {
      rmSync(userData, { recursive: true, force: true });
    }
  };
}

test("desktop managed config enables layered context retention by default", () => {
  const { harness, cleanup } = createHarness();
  try {
    const configPath = harness.writeDesktopManagedConfig(defaultSettings());
    const content = readFileSync(configPath, "utf8");

    assert.match(content, /reasoning_effort = "max"/);
    assert.match(content, /\[context\]/);
    assert.match(content, /enabled = true/);
    assert.match(content, /verbatim_window_turns = 16/);
    assert.match(content, /seam_model = "deepseek-v4-flash"/);
  } finally {
    cleanup();
  }
});

test("desktop managed config preserves layered context overrides", () => {
  const { harness, cleanup } = createHarness();
  try {
    const configPath = harness.writeDesktopManagedConfig({
      ...defaultSettings(),
      layeredContextEnabled: false,
      contextVerbatimWindowTurns: 28
    });
    const content = readFileSync(configPath, "utf8");

    assert.match(content, /enabled = false/);
    assert.match(content, /verbatim_window_turns = 28/);
  } finally {
    cleanup();
  }
});
