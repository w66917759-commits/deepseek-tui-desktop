const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
const mainSource = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.resolve(__dirname, "../electron/preload.cjs"), "utf8");
const globalTypesSource = fs.readFileSync(path.resolve(__dirname, "../src/global.d.ts"), "utf8");

test("renderer defaults to DeepSeek TUI sub-agent concurrency", () => {
  assert.match(appSource, /maxSubagents:\s*10/);
  assert.doesNotMatch(appSource, /maxSubagents:\s*3/);
});

test("renderer defaults include conversation skills for daily tasks and Skill downloads", () => {
  assert.match(appSource, /enabledSkills:\s*\["superpowers",\s*"ui-ux-design",\s*"cron-scheduler",\s*"skill-downloader"\]/);
  assert.match(appSource, /id:\s*"skill-downloader"/);
  assert.match(appSource, /Skill 下载|Skill Download/);
});

test("conversation topbar keeps workspace and branch controls out of the header", () => {
  const topbarMatch = appSource.match(/<header className="conversation-topbar">([\s\S]*?)<\/header>/);
  assert.ok(topbarMatch, "conversation topbar markup should exist");

  assert.doesNotMatch(topbarMatch[1], /workspace-picker-button/);
  assert.doesNotMatch(topbarMatch[1], /branch-status-button/);
  assert.doesNotMatch(topbarMatch[1], /selectedWorkspaceLabel/);
  assert.doesNotMatch(topbarMatch[1], /currentBranchLabel/);
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

  const composerMatch = appSource.match(/<footer className="composer">([\s\S]*?)<div className="composer-input">/);
  assert.ok(composerMatch, "composer markup should exist");
  assert.match(composerMatch[1], /workspace-picker-button/);
  assert.match(composerMatch[1], /onClick=\{chooseWorkspace\}/);
  assert.match(composerMatch[1], /t\.topbar\.chooseWorkspace/);
  assert.match(composerMatch[1], /<span>\{selectedWorkspaceLabel\}<\/span>/);
  assert.doesNotMatch(composerMatch[1], /<span>\{t\.topbar\.chooseWorkspace\}<\/span>/);
});

test("composer places branch and workspace controls before the process stream toggle", () => {
  assert.match(appSource, /const currentBranchLabel = gitStatus\?\.isRepo && gitStatus\.branch/);
  assert.match(appSource, /loadGitStatus\(\)\.catch/);

  const composerMatch = appSource.match(/<footer className="composer">([\s\S]*?)<div className="composer-input">/);
  assert.ok(composerMatch, "composer markup should exist");
  assert.match(composerMatch[1], /YOLO[\s\S]*branch-status-button[\s\S]*workspace-picker-button[\s\S]*process-stream-toggle/);
  assert.match(composerMatch[1], /<GitBranch size=\{16\} aria-hidden \/>/);
  assert.match(composerMatch[1], /<span>\{currentBranchLabel\}<\/span>/);
  assert.match(composerMatch[1], /setInspectorPanel\("git"\)/);
});

test("process stream toggle controls panel visibility and active source output", () => {
  assert.match(appSource, /const processStreamEnabled = settings\.harnessEnabled/);
  assert.match(appSource, /const toggleProcessStream = useCallback/);
  assert.match(appSource, /if \(!nextEnabled && running\) \{\s*void stop\(\);/);
  assert.match(appSource, /processStreamEnabled \? "conversation-layout" : "conversation-layout process-panel-collapsed"/);
  assert.match(appSource, /\{processStreamEnabled \? terminalPanel : null\}/);

  const composerMatch = appSource.match(/<footer className="composer">([\s\S]*?)<div className="composer-input">/);
  assert.ok(composerMatch, "composer markup should exist");
  assert.match(composerMatch[1], /className=\{processStreamEnabled \? "process-stream-toggle active" : "process-stream-toggle"\}/);
  assert.match(composerMatch[1], /onClick=\{toggleProcessStream\}/);
});

test("composer model picker omits the official docs link from the home view", () => {
  const composerMatch = appSource.match(/<label className="model-picker">([\s\S]*?)<\/label>/);
  assert.ok(composerMatch, "composer model picker should exist");
  assert.doesNotMatch(composerMatch[1], /model-doc-link/);
  assert.doesNotMatch(composerMatch[1], /t\.settings\.modelDoc/);
  assert.doesNotMatch(composerMatch[1], /selectedModelPreset\.docsUrl/);
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

test("Skills and MCP tools keep add flows without raw edit panels", () => {
  const skillsPageMatch = appSource.match(/const skillsToolPage = \(([\s\S]*?)\n  const mcpToolPage = \(/);
  assert.ok(skillsPageMatch, "skills tool page should exist");
  assert.match(skillsPageMatch[1], /createSkill/);
  assert.match(skillsPageMatch[1], /importSkills/);
  assert.doesNotMatch(skillsPageMatch[1], /saveSkillDraft/);
  assert.doesNotMatch(skillsPageMatch[1], /selectSkillTemplate/);
  assert.doesNotMatch(skillsPageMatch[1], /t\.skills\.editorTitle/);
  assert.doesNotMatch(skillsPageMatch[1], /t\.skills\.saveTemplate/);
  assert.doesNotMatch(skillsPageMatch[1], /skillDraft/);

  const mcpPageMatch = appSource.match(/const mcpToolPage = \(([\s\S]*?)\n  const scheduledTasksPage = \(/);
  assert.ok(mcpPageMatch, "MCP tool page should exist");
  assert.match(mcpPageMatch[1], /addCustomMcpServer/);
  assert.match(mcpPageMatch[1], /t\.mcp\.addCustom/);
  assert.doesNotMatch(mcpPageMatch[1], /saveMcpDraft/);
  assert.doesNotMatch(mcpPageMatch[1], /useMcpPresetDraft/);
  assert.doesNotMatch(mcpPageMatch[1], /t\.mcp\.editorTitle/);
  assert.doesNotMatch(mcpPageMatch[1], /t\.mcp\.saveConfig/);
  assert.doesNotMatch(mcpPageMatch[1], /template-textarea mcp-json/);
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

test("runtime state is exposed through IPC and rendered in an Agents panel", () => {
  assert.match(mainSource, /runtime:snapshot/);
  assert.match(mainSource, /runtime:event/);
  assert.match(mainSource, /harness\.getRuntimeSnapshot\(\)/);
  assert.match(preloadSource, /getRuntimeSnapshot/);
  assert.match(preloadSource, /onRuntimeSnapshot/);
  assert.match(preloadSource, /onRuntimeEvent/);
  assert.match(globalTypesSource, /interface RuntimeSnapshot/);
  assert.match(globalTypesSource, /interface RuntimeAgent/);

  assert.match(appSource, /type MainView = "chat" \| "tools" \| "tasks" \| "agents" \| "terminal"/);
  assert.match(appSource, /const \[runtimeSnapshot, setRuntimeSnapshot\]/);
  assert.match(appSource, /desktop\.onRuntimeSnapshot/);
  assert.match(appSource, /const agentsPanel = \(/);
  assert.match(appSource, /mainView === "agents" \? agentsPanel : null/);
});

test("sidebar always exposes Agents with a zero-count-capable badge", () => {
  const sidebarActionsMatch = appSource.match(/<section className="sidebar-actions">([\s\S]*?)<\/section>/);
  assert.ok(sidebarActionsMatch, "sidebar actions should exist");
  assert.match(sidebarActionsMatch[1], /mainView === "agents"/);
  assert.match(sidebarActionsMatch[1], /setMainView\("agents"\)/);
  assert.match(sidebarActionsMatch[1], /<Bot size=\{16\} aria-hidden \/>/);
  assert.match(sidebarActionsMatch[1], /runtimeSnapshot\.counts\.total/);
});
