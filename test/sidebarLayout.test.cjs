const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const css = readFileSync(join(__dirname, "../src/styles.css"), "utf8");

function cssBlock(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?\\}`));
  assert.ok(match, `Missing CSS block for ${selector}`);
  return match[0];
}

test("sidebar history list stays content-sized until it reaches its height cap", () => {
  const historyShell = cssBlock(".history-scroll-shell");
  const sidebarSpacer = cssBlock(".sidebar-spacer");

  assert.match(historyShell, /flex:\s*0\s+1\s+auto;/);
  assert.match(historyShell, /max-height:\s*min\(44vh,\s*360px\);/);
  assert.match(historyShell, /overflow:\s*hidden;/);
  assert.doesNotMatch(historyShell, /flex:\s*1\s+1\s+auto;/);
  assert.match(sidebarSpacer, /flex:\s*1\s+1\s+auto;/);
});

test("scheduled task sidebar action opens the automation task view", () => {
  const appSource = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");
  const match = appSource.match(/const openScheduledTasksPage = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);

  assert.ok(match, "Missing openScheduledTasksPage callback");
  assert.match(match[1], /setMainView\("tasks"\);/);
  assert.doesNotMatch(match[1], /setMainView\("tools"\);/);
  assert.doesNotMatch(match[1], /setToolPage\("skills"\);/);
});
