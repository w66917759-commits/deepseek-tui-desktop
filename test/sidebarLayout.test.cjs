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

test("runtime agent board is hidden until live runtime state exists", () => {
  const appSource = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");

  assert.match(appSource, /type MainView = "chat" \| "tools" \| "tasks";/);
  assert.match(appSource, /const shouldShowAgentRuntimeBoard = activeRuntimeCount > 0 \|\| visibleRuntimeAgents\.length > 0;/);
  assert.match(appSource, /\{shouldShowAgentRuntimeBoard \? agentRuntimeBoard : null\}/);
  assert.doesNotMatch(appSource, /waitingChildAgentText/);
  assert.doesNotMatch(appSource, /mainView === "terminal"/);
});

test("task board is rendered in the chat surface and executes through per-item runtime turns", () => {
  const appSource = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");

  assert.match(appSource, /const taskBoardPanel = activeTaskBoardWithRuntimeStatus/);
  assert.match(appSource, /\{taskBoardPanel\}\s*\n\s*\{routingPanel\}/);
  assert.match(appSource, /buildTaskBoardItemExecutionPrompt\(\{/);
  assert.match(appSource, /nextRunnableTaskBoardItem\(workingBoard\)/);
  assert.match(appSource, /shouldCreateTaskBoard\(\{/);
  assert.match(css, /\.task-board-panel/);
  assert.match(css, /\.task-board-card/);
});

test("tool overview cards are static, not duplicate navigation buttons", () => {
  const appSource = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");
  const match = appSource.match(/<div className="dashboard-grid">([\s\S]*?)\n\s*<\/div>\n\n\s*\{runtimeApiPanel\}/);

  assert.ok(match, "Missing tool overview dashboard grid");
  assert.doesNotMatch(match[1], /<button[^>]*className="metric-card"/);
  assert.equal((match[1].match(/<article className="metric-card">/g) || []).length, 3);
  assert.doesNotMatch(appSource, /<button[\s\S]{0,160}className=\{enabled \? `tool-card/);
  assert.doesNotMatch(appSource, /<button[\s\S]{0,160}className=\{enabled \? "skill-card/);
  assert.match(appSource, /<article[\s\S]{0,120}key=\{preset\.id\}[\s\S]{0,120}className=\{enabled \? `tool-card/);
  assert.match(appSource, /<article[\s\S]{0,120}key=\{skill\.id\}[\s\S]{0,120}className=\{enabled \? "skill-card/);
});

test("new chat cannot create a no-workspace project", () => {
  const appSource = readFileSync(join(__dirname, "../src/App.tsx"), "utf8");
  const match = appSource.match(/const createProjectConversation = useCallback\(\(workspacePath: string\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/);

  assert.ok(match, "Missing createProjectConversation callback");
  assert.match(match[1], /const normalizedWorkspacePath = workspacePath\.trim\(\);/);
  assert.match(match[1], /if \(!normalizedWorkspacePath\) \{/);
  assert.match(match[1], /setStatus\(\{ type: "error", message: t\.topbar\.noWorkspace \}\);/);
  assert.match(appSource, /disabled=\{!selectedWorkspacePath\.trim\(\)\}/);
});

test("dead agent and terminal-only styles stay removed", () => {
  assert.doesNotMatch(css, /\.terminal-card\.terminal-expanded/);
  assert.doesNotMatch(css, /\.terminal-card\.terminal-hidden/);
  assert.doesNotMatch(css, /\.agents-panel/);
  assert.doesNotMatch(css, /\.agent-runtime-row/);
  assert.doesNotMatch(css, /button\.metric-card:hover/);
  assert.doesNotMatch(css, /button\.tool-card:hover/);
  assert.doesNotMatch(css, /button\.skill-card:hover/);
});
