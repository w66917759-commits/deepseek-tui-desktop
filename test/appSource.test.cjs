const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");

test("conversation topbar exposes direct workspace selection", () => {
  const topbarMatch = appSource.match(/<header className="conversation-topbar">([\s\S]*?)<\/header>/);
  assert.ok(topbarMatch, "conversation topbar markup should exist");

  assert.match(topbarMatch[1], /workspace-picker-button/);
  assert.match(topbarMatch[1], /onClick=\{chooseWorkspace\}/);
  assert.match(topbarMatch[1], /t\.topbar\.chooseWorkspace/);
  assert.match(topbarMatch[1], /selectedWorkspaceLabel/);
});

test("conversation topbar omits scheduled task and process view buttons", () => {
  const topbarMatch = appSource.match(/<header className="conversation-topbar">([\s\S]*?)<\/header>/);
  assert.ok(topbarMatch, "conversation topbar markup should exist");

  assert.doesNotMatch(topbarMatch[1], /mainView === "tasks"/);
  assert.doesNotMatch(topbarMatch[1], /mainView === "terminal"/);
  assert.doesNotMatch(topbarMatch[1], /openScheduledTasksPage/);
  assert.doesNotMatch(topbarMatch[1], /t\.topbar\.tasks/);
  assert.doesNotMatch(topbarMatch[1], /t\.topbar\.terminal/);
});

test("workspace picker displays the selected project name", () => {
  assert.match(appSource, /const selectedWorkspacePath = activeSession\?\.workspacePath \|\| settings\.workspacePath;/);
  assert.match(appSource, /projectNameFromWorkspace\(selectedWorkspacePath, language\)/);
  assert.match(appSource, /const selectedWorkspaceLabel = selectedWorkspacePath\.trim\(\)/);

  const topbarMatch = appSource.match(/<header className="conversation-topbar">([\s\S]*?)<\/header>/);
  assert.ok(topbarMatch, "conversation topbar markup should exist");
  assert.match(topbarMatch[1], /<span>\{selectedWorkspaceLabel\}<\/span>/);
  assert.doesNotMatch(topbarMatch[1], /<span>\{t\.topbar\.chooseWorkspace\}<\/span>/);
});

test("workspace chooser persists the selected workspace immediately", () => {
  const chooserMatch = appSource.match(/const chooseWorkspace = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[[^\]]+\]\);/);
  assert.ok(chooserMatch, "chooseWorkspace callback should exist");

  assert.match(chooserMatch[1], /desktop\.saveSettings/);
  assert.match(chooserMatch[1], /workspacePath: selected/);
});

test("DeepSeek model selector links four choices to official docs and canonical API models", () => {
  assert.match(appSource, /DeepSeek v4 Pro/);
  assert.match(appSource, /DeepSeek v4 Pro 1M/);
  assert.match(appSource, /DeepSeek v4 Flash/);
  assert.match(appSource, /DeepSeek v4 Flash 1M/);
  assert.match(appSource, /api-docs\.deepseek\.com\/news\/news260424/);
  assert.match(appSource, /api-docs\.deepseek\.com\/quick_start\/pricing\//);
  assert.match(appSource, /apiModel:\s*"deepseek-v4-pro"/);
  assert.match(appSource, /apiModel:\s*"deepseek-v4-flash"/);
  assert.doesNotMatch(appSource, /apiModel:\s*"deepseek-v4-pro-1m"/);
  assert.doesNotMatch(appSource, /apiModel:\s*"deepseek-v4-flash-1m"/);
});

test("topbar exposes a global DeepSeek API key action", () => {
  assert.match(appSource, /api-key-global-button/);
  assert.match(appSource, /t\.topbar\.apiKeySaved/);
  assert.match(appSource, /t\.topbar\.apiKeyMissing/);
  assert.match(appSource, /setInspectorPanel\("settings"\)/);
});

test("process panel output is scoped to the selected conversation session", () => {
  assert.match(appSource, /terminalOutputBySessionRef\s*=\s*useRef<Record<string,\s*string>>/);
  assert.match(appSource, /renderTerminalForSession\s*=\s*useCallback/);
  assert.match(appSource, /activeSessionIdRef\.current\s*===\s*capture\.sessionId/);

  const terminalDataMatch = appSource.match(/desktop\.onTerminalData\(\(data\) => \{([\s\S]*?)\n    \}\);/);
  assert.ok(terminalDataMatch, "terminal data listener should exist");
  assert.match(terminalDataMatch[1], /terminalOutputBySessionRef\.current\[terminalSessionId\]/);
  assert.match(terminalDataMatch[1], /activeSessionIdRef\.current\s*===\s*terminalSessionId/);
  assert.match(terminalDataMatch[1], /terminalRef\.current\?\.write\(data\)/);

  const selectProjectMatch = appSource.match(/const selectProject = useCallback\(\(project: ConversationProject\) => \{([\s\S]*?)\n  \}, \[[^\]]+\]\);/);
  assert.ok(selectProjectMatch, "selectProject callback should exist");
  assert.match(selectProjectMatch[1], /renderTerminalForSession\(session\?\.id/);

  const selectConversationMatch = appSource.match(/const selectConversation = useCallback\(\(sessionId: string\) => \{([\s\S]*?)\n  \}, \[[^\]]+\]\);/);
  assert.ok(selectConversationMatch, "selectConversation callback should exist");
  assert.match(selectConversationMatch[1], /renderTerminalForSession\(session\.id/);
});
