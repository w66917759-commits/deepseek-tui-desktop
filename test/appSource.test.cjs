const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
const styleSource = fs.readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");
const desktopApiSource = fs.readFileSync(path.resolve(__dirname, "../src/desktopApi.ts"), "utf8");
const mainSource = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.resolve(__dirname, "../electron/preload.cjs"), "utf8");
const globalTypesSource = fs.readFileSync(path.resolve(__dirname, "../src/global.d.ts"), "utf8");

test("renderer defaults to DeepSeek TUI sub-agent concurrency", () => {
  assert.match(appSource, /maxSubagents:\s*10/);
  assert.doesNotMatch(appSource, /maxSubagents:\s*3/);
});

test("renderer defaults include conversation skills for daily tasks and Skill downloads", () => {
  assert.match(appSource, /enabledSkills:\s*\["superpowers",\s*"ui-ux-pro-max",\s*"cron-scheduler",\s*"skill-downloader"\]/);
  assert.match(appSource, /id:\s*"ui-ux-pro-max"/);
  assert.match(appSource, /id:\s*"skill-downloader"/);
  assert.doesNotMatch(appSource, /id:\s*"harness-probe-rollback"/);
  assert.doesNotMatch(appSource, /Harness Probe Rollback/);
  assert.doesNotMatch(desktopApiSource, /harness-probe-rollback/);
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

test("composer places branch and workspace controls before the model picker without a process stream toggle", () => {
  assert.match(appSource, /const currentBranchLabel = gitStatus\?\.isRepo && gitStatus\.branch/);
  assert.match(appSource, /loadGitStatus\(\)\.catch/);

  const composerMatch = appSource.match(/<footer className="composer">([\s\S]*?)<div className="composer-input">/);
  assert.ok(composerMatch, "composer markup should exist");
  assert.match(composerMatch[1], /YOLO[\s\S]*branch-status-button[\s\S]*workspace-picker-button[\s\S]*model-picker/);
  assert.doesNotMatch(composerMatch[1], /process-stream-toggle/);
  assert.match(composerMatch[1], /<GitBranch size=\{16\} aria-hidden \/>/);
  assert.match(composerMatch[1], /<span>\{currentBranchLabel\}<\/span>/);
  assert.match(composerMatch[1], /setInspectorPanel\("git"\)/);
});

test("composer keeps Harness out of runtime controls and Skills", () => {
  assert.match(appSource, /type PermissionMode = "plan" \| "agent" \| "yolo"/);
  assert.match(appSource, /const \[permissionMode, setPermissionMode\] = useState<PermissionMode>\("agent"\)/);
  assert.match(appSource, /processStreamEnabled,\s*\n\s*model: selectedModelApiName/);
  assert.match(appSource, /const launchAction: LaunchAction = permissionMode === "plan" \? "plan" : permissionMode === "yolo" \? "yolo" : "exec"/);
  assert.doesNotMatch(appSource, /id:\s*"harness-probe-rollback"/);
  assert.doesNotMatch(appSource, /Harness Probe Rollback/);
  assert.doesNotMatch(appSource, /Harness 探针回滚/);
  assert.doesNotMatch(appSource, /const \[harnessPresetEnabled, setHarnessPresetEnabled\]/);
  assert.doesNotMatch(appSource, /harness-mode-button/);
  assert.doesNotMatch(appSource, /harnessContent/);
  assert.doesNotMatch(appSource, /harnessPlaceholder/);
  assert.doesNotMatch(appSource, /type AgentMode/);
  assert.doesNotMatch(appSource, /permissionMode === "harness"/);
  assert.doesNotMatch(appSource, /setPermissionMode\("harness"\)/);
  assert.doesNotMatch(appSource, /harnessEnabled:\s*permissionMode === "harness"/);
  assert.doesNotMatch(appSource, /harnessEnabled:\s*harnessPresetEnabled/);
  assert.doesNotMatch(appSource, /const processStreamEnabled = settings\.harnessEnabled/);
  assert.doesNotMatch(appSource, /\{processStreamEnabled \? terminalPanel : null\}/);

  const composerMatch = appSource.match(/<footer className="composer">([\s\S]*?)<div className="composer-input">/);
  assert.ok(composerMatch, "composer markup should exist");
  const modeSwitchMatch = composerMatch[1].match(/<div className="agent-mode-switch"[\s\S]*?<\/div>/);
  assert.ok(modeSwitchMatch, "agent mode switch should exist");
  assert.match(modeSwitchMatch[0], /Plan[\s\S]*Agent[\s\S]*YOLO/);
  assert.doesNotMatch(modeSwitchMatch[0], /Harness/);
  assert.match(composerMatch[1], /agent-mode-switch[\s\S]*branch-status-button/);
  assert.doesNotMatch(composerMatch[1], /harness-mode-button/);
  assert.doesNotMatch(composerMatch[1], /Harness/);
});

test("process stream remains an internal default without a home composer toggle", () => {
  assert.match(appSource, /processStreamEnabled:\s*true/);
  assert.match(globalTypesSource, /processStreamEnabled:\s*boolean/);
  assert.match(appSource, /const processStreamEnabled = settings\.processStreamEnabled !== false/);
  assert.doesNotMatch(appSource, /const toggleProcessStream = useCallback/);
  assert.doesNotMatch(appSource, /processStream:\s*"过程流"/);
  assert.doesNotMatch(appSource, /processStream:\s*"Process Stream"/);
  assert.doesNotMatch(appSource, /processStreamMode/);
  assert.doesNotMatch(appSource, /processStreamHint/);
  assert.doesNotMatch(appSource, /process-stream-toggle/);
});

test("topbar opens Cursor directly and omits the unlabeled runtime check button", () => {
  const topbarMatch = appSource.match(/<header className="conversation-topbar">([\s\S]*?)<\/header>/);
  assert.ok(topbarMatch, "conversation topbar markup should exist");

  assert.match(appSource, /openCursor:\s*"打开 Cursor"/);
  assert.match(appSource, /openCursor:\s*"Open Cursor"/);
  assert.doesNotMatch(appSource, /openCursor:\s*"导出到 Cursor"/);
  assert.doesNotMatch(appSource, /openCursor:\s*"Export to Cursor"/);
  assert.doesNotMatch(topbarMatch[1], /title=\{\`\$\{t\.topbar\.checkRuntime\}/);
  assert.doesNotMatch(topbarMatch[1], /<Activity size=\{17\} aria-hidden \/>/);
});

test("running state has animated activity marks in chat and sidebar", () => {
  assert.match(appSource, /Fish/);
  assert.match(appSource, /Waves/);
  assert.match(appSource, /Droplets/);
  assert.match(appSource, /LoaderCircle/);
  assert.match(appSource, /function RunningActivityMark/);
  assert.match(appSource, /sidebar-run-state/);
  assert.match(appSource, /message-row \$\{message\.role\} \$\{isRunningReply/);
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

test("DeepSeek home model selector highlights only Pro and Flash", () => {
  assert.match(appSource, /DeepSeek v4 Pro/);
  assert.match(appSource, /DeepSeek v4 Pro 1M/);
  assert.match(appSource, /DeepSeek v4 Flash/);
  assert.match(appSource, /DeepSeek v4 Flash 1M/);
  assert.match(appSource, /const primaryModelPresets = modelPresets\.filter/);
  const composerMatch = appSource.match(/<label className="model-picker">([\s\S]*?)<\/label>/);
  assert.ok(composerMatch, "composer model picker should exist");
  assert.match(composerMatch[1], /primaryModelPresets\.map/);
  assert.doesNotMatch(composerMatch[1], /modelPresets\.map/);
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

test("Git panel exposes branch selection and safe branch switching", () => {
  assert.match(globalTypesSource, /interface GitBranchInfo/);
  assert.match(globalTypesSource, /switchGitBranch: \(payload: GitBranchSwitchPayload\) => Promise<GitActionResult>/);
  assert.match(preloadSource, /switchGitBranch: \(payload\) => ipcRenderer\.invoke\("git:switch-branch", payload\)/);
  assert.match(mainSource, /git:switch-branch/);
  assert.match(mainSource, /harness\.gitSwitchBranch/);

  const gitPanelMatch = appSource.match(/\{inspectorPanel === "git" \? \(([\s\S]*?)\n          \) : null\}/);
  assert.ok(gitPanelMatch, "Git inspector panel should exist");
  assert.match(gitPanelMatch[1], /className="branch-select-row"/);
  assert.match(gitPanelMatch[1], /gitStatus\.branches\.map/);
  assert.match(gitPanelMatch[1], /onChange=\{\(event\) => switchGitBranch\(event\.target\.value\)\}/);
  assert.match(gitPanelMatch[1], /disabled=\{gitBusy \|\| gitStatus\.hasChanges\}/);
  assert.match(appSource, /const switchGitBranch = useCallback\(async \(branchName: string\)/);
  assert.match(appSource, /await desktop\.switchGitBranch/);
  assert.match(appSource, /t\.git\.switchBranchOk/);
  assert.match(appSource, /t\.git\.dirtyBranchBlocked/);
});

test("lightweight shell keeps core controls and tool entries visible", () => {
  const sidebarMatch = appSource.match(/<section className="sidebar-actions">([\s\S]*?)<\/section>/);
  assert.ok(sidebarMatch, "sidebar actions should exist");
  assert.match(sidebarMatch[1], /Skills/);
  assert.match(sidebarMatch[1], /MCP/);
  assert.match(sidebarMatch[1], /t\.sidebar\.automations/);

  const composerMatch = appSource.match(/<footer className="composer">([\s\S]*?)<div className="composer-input">/);
  assert.ok(composerMatch, "composer markup should exist");
  assert.match(composerMatch[1], /Plan[\s\S]*Agent[\s\S]*YOLO/);
  assert.match(composerMatch[1], /branch-status-button/);
  assert.match(composerMatch[1], /workspace-picker-button/);
  assert.match(composerMatch[1], /model-picker/);

  assert.match(appSource, /terminalPanel/);
  assert.doesNotMatch(appSource, /streaming-output-hero/);
});

test("settings keeps advanced runtime details out of the simple path", () => {
  const settingsMatch = appSource.match(/\{inspectorPanel === "settings" \? \(([\s\S]*?)\n          \) : null\}/);
  assert.ok(settingsMatch, "settings panel should exist");
  assert.match(settingsMatch[1], /className="advanced-settings"/);
  assert.match(settingsMatch[1], /t\.settings\.advancedRuntime/);
  assert.match(settingsMatch[1], /primaryModelPresets\.map/);
  assert.match(settingsMatch[1], /modelPresets\.map/);
  assert.match(settingsMatch[1], /value=\{settings\.binaryMode\}/);
  assert.match(settingsMatch[1], /value=\{settings\.customBinaryPath\}/);
});

test("MCP presets keep the common lightweight set first", () => {
  const presetOrder = Array.from(appSource.matchAll(/id:\s*"([^"]+)"/g)).map((match) => match[1]);
  const mcpStart = presetOrder.indexOf("filesystem");
  assert.notEqual(mcpStart, -1, "filesystem MCP preset should exist");
  assert.deepEqual(presetOrder.slice(mcpStart, mcpStart + 5), [
    "filesystem",
    "github",
    "playwright",
    "context7",
    "postgres"
  ]);
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

test("MCP tool page exposes adapter status before runtime injection", () => {
  assert.match(appSource, /mcpAdapterRows/);
  assert.match(appSource, /mcp-adapter-panel/);
  assert.match(appSource, /t\.mcp\.adapterTitle/);
  assert.match(appSource, /t\.mcp\.adapterDesc/);
  assert.match(appSource, /saveMcpEnvSecret/);
  assert.match(appSource, /mcpSecretKey/);
  assert.match(appSource, /t\.mcp\.configureEnvKey/);
  assert.match(appSource, /t\.mcp\.saveSecret/);
  assert.match(appSource, /t\.mcp\.guide/);
  assert.match(appSource, /server\.injectable \? t\.mcp\.injectable : t\.mcp\.notInjected/);
  assert.match(globalTypesSource, /type McpAdapterStatus = "ready" \| "needs-auth" \| "needs-config" \| "command-missing" \| "invalid-url"/);
  assert.match(globalTypesSource, /injectable:\s*boolean/);
});

test("MCP tool page provides guided setup actions for token and OAuth presets", () => {
  const mcpPageMatch = appSource.match(/const mcpToolPage = \(([\s\S]*?)\n  const scheduledTasksPage = \(/);
  assert.ok(mcpPageMatch, "MCP tool page should exist");
  assert.match(appSource, /mcpSetupRows/);
  assert.match(appSource, /mcp-setup-panel/);
  assert.match(appSource, /mcp-setup-card/);
  assert.match(appSource, /mcpSecretTarget/);
  assert.match(appSource, /mcpGuideActionLabel/);
  assert.match(appSource, /mcpSetupButtonLabel/);
  assert.match(appSource, /configureEnvKey/);
  assert.match(mcpPageMatch[1], /t\.mcp\.setupTitle/);
  assert.match(mcpPageMatch[1], /t\.mcp\.setupDesc/);
  assert.match(mcpPageMatch[1], /t\.mcp\.openGuide/);
  assert.match(mcpPageMatch[1], /t\.mcp\.chooseService/);
  assert.match(mcpPageMatch[1], /openMcpGuide\(preset\)/);
  assert.match(appSource, /https:\/\/github\.com\/settings\/tokens/);
  assert.match(appSource, /https:\/\/www\.npmjs\.com\/package\/mcp-remote/);
});

test("MCP tool opens into searchable setup instead of the stale inspector panel", () => {
  const mcpPageMatch = appSource.match(/const mcpToolPage = \(([\s\S]*?)\n  const scheduledTasksPage = \(/);
  assert.ok(mcpPageMatch, "MCP tool page should exist");
  const mcpPage = mcpPageMatch[1];
  assert.match(mcpPage, /mcpSearchInputRef/);
  assert.match(mcpPage, /className="mcp-setup-search"/);
  assert.match(mcpPage, /filteredMcpPresets\.map/);
  assert.match(mcpPage, /selectMcpForSetup\(preset\)/);
  assert.ok(
    mcpPage.indexOf("mcp-setup-panel") < mcpPage.indexOf("custom-mcp-builder"),
    "the setup workflow should be the first MCP interaction before custom JSON entry"
  );
  assert.doesNotMatch(mcpPage, /t\.mcp\.selectFirst/);
  assert.doesNotMatch(appSource, /inspectorPanel === "mcp"/);
});

test("MCP setup links open externally through the desktop shell", () => {
  assert.match(appSource, /openMcpGuide/);
  assert.match(appSource, /desktop\.openExternal/);
  assert.match(preloadSource, /openExternal: \(url\) => ipcRenderer\.invoke\("app:open-external", url\)/);
  assert.match(mainSource, /shell\.openExternal/);
  assert.match(globalTypesSource, /openExternal: \(url: string\) => Promise/);
});

test("browser preview preset skills include MCP readiness boundaries", () => {
  assert.match(desktopApiSource, /## MCP Boundaries/);
  assert.match(desktopApiSource, /launch-time injection as allowed only when adapter preflight reports the MCP as ready/);
  assert.match(desktopApiSource, /## State Clarity/);
  assert.match(desktopApiSource, /Separate selected, saved, injected, authenticated, connected, callable, failed, and disabled/);
});

test("terminal output capture is scoped to the selected conversation session", () => {
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
  assert.match(selectProjectMatch[1], /renderTerminalForSession\(session(?:\?\.|\.)id/);

  const selectConversationMatch = appSource.match(/const selectConversation = useCallback\(\(sessionId: string\) => \{([\s\S]*?)\n  \}, \[[^\]]+\]\);/);
  assert.ok(selectConversationMatch, "selectConversation callback should exist");
  assert.match(selectConversationMatch[1], /renderTerminalForSession\(session\.id/);
});

test("project history sidebar supports solo expand and collapse", () => {
  assert.match(appSource, /const \[expandedProjectIds, setExpandedProjectIds\] = useState<Set<string>>/);
  assert.match(appSource, /const projectIsExpanded = expandedProjectIds\.has\(project\.id\)/);
  assert.match(appSource, /aria-expanded=\{projectIsExpanded\}/);
  assert.match(appSource, /projectIsExpanded \? project\.sessions\.map/);

  const selectProjectMatch = appSource.match(/const selectProject = useCallback\(\(project: ConversationProject\) => \{([\s\S]*?)\n  \}, \[[^\]]+\]\);/);
  assert.ok(selectProjectMatch, "selectProject callback should exist");
  assert.match(selectProjectMatch[1], /setExpandedProjectIds\(\(current\) => \{/);
  assert.match(selectProjectMatch[1], /return projectIsExpanded \? new Set<string>\(\) : new Set\(\[project\.id\]\);/);

  const selectConversationMatch = appSource.match(/const selectConversation = useCallback\(\(sessionId: string\) => \{([\s\S]*?)\n  \}, \[[^\]]+\]\);/);
  assert.ok(selectConversationMatch, "selectConversation callback should exist");
  assert.match(selectConversationMatch[1], /setExpandedProjectIds\(\(\) => new Set\(\[session\.projectId\]\)\)/);
});

test("project history sidebar has explicit up and down scroll controls", () => {
  assert.match(appSource, /const historyScrollRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(appSource, /const scrollHistory = useCallback\(\(direction: "up" \| "down"\) => \{/);
  assert.match(appSource, /node\.scrollBy\(\{\s*top: direction === "up" \? -historyScrollStep : historyScrollStep,\s*behavior: "smooth"\s*\}\)/);
  assert.match(appSource, /className="history-scroll-shell"/);
  assert.match(appSource, /className="history-scroll-button top"/);
  assert.match(appSource, /className="history-scroll-button bottom"/);
  assert.match(appSource, /ref=\{historyScrollRef\}[\s\S]*className="history-tree history-scroll-pane"/);
  assert.match(styleSource, /\.history-scroll-shell\s*\{[\s\S]*min-height:\s*0/);
  assert.match(styleSource, /\.history-scroll-pane\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(styleSource, /\.history-scroll-button\s*\{[\s\S]*position:\s*sticky/);
});

test("runtime state is exposed through IPC in the right-side streaming output panel", () => {
  assert.match(mainSource, /runtime:snapshot/);
  assert.match(mainSource, /runtime:event/);
  assert.match(mainSource, /harness\.getRuntimeSnapshot\(\)/);
  assert.match(preloadSource, /getRuntimeSnapshot/);
  assert.match(preloadSource, /onRuntimeSnapshot/);
  assert.match(preloadSource, /onRuntimeEvent/);
  assert.match(globalTypesSource, /interface RuntimeSnapshot/);
  assert.match(globalTypesSource, /interface RuntimeAgent/);

  assert.match(appSource, /type MainView = "chat" \| "tools" \| "tasks" \| "terminal"/);
  assert.match(appSource, /const \[runtimeSnapshot, setRuntimeSnapshot\]/);
  assert.match(appSource, /desktop\.onRuntimeSnapshot/);
  assert.match(appSource, /const conversationLayoutClassName = "conversation-layout conversation-layout-with-stream"/);
  assert.match(appSource, /runtimeOrchestratorSnapshot\.turns/);
  assert.match(appSource, /const parentRuntimeTurns = runtimeOrchestratorSnapshot\.turns/);
  assert.match(appSource, /const visibleRuntimeAgents = runtimeSnapshot\.agents/);
  assert.doesNotMatch(appSource, /activeRuntimeTurnAgents/);
  assert.doesNotMatch(appSource, /runtimeSnapshot\.agents\.length > 0 \? runtimeSnapshot\.agents :/);
  assert.match(appSource, /const agentRuntimeBoard = \(/);
  assert.match(appSource, /className="terminal-title"/);
  assert.match(appSource, /terminalHostRef\} className="terminal-host"[\s\S]*\{agentRuntimeBoard\}/);
  assert.match(appSource, /\{mainView === "chat" \|\| mainView === "terminal" \? terminalPanel : null\}/);
  assert.doesNotMatch(appSource, /\{mainView === "chat" \? agentRuntimeBoard : null\}/);
  assert.doesNotMatch(appSource, /conversationLayoutClassName = "conversation-layout conversation-layout-single"/);
  assert.doesNotMatch(appSource, /mainView === "agents" \? agentsPanel : null/);
  assert.match(appSource, /visibleRuntimeAgents\.map\(\(agent\)/);
  assert.match(appSource, /parentRuntimeTurns\.map\(\(turn\)/);
  assert.match(appSource, /parentRuntimeLabel/);
  assert.match(appSource, /childAgentLabel/);
  assert.match(appSource, /\{agent\.name\}/);
  assert.match(styleSource, /\.conversation-layout-with-stream\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(340px,\s*380px\)/);
  assert.match(styleSource, /\.conversation-layout-with-stream \.chat-output-list/);
  assert.match(styleSource, /\.terminal-card\.stream-output-card\s*\{[\s\S]*height:\s*100%/);
});

test("composer routes sends through the conversation-scoped runtime orchestrator", () => {
  assert.match(mainSource, /runtime:startTurn/);
  assert.match(mainSource, /runtime:cancelTurn/);
  assert.match(mainSource, /orchestrator\.startTurn/);
  assert.match(mainSource, /createDeepSeekCliRunner/);
  assert.match(mainSource, /harness\.buildLaunchPlan/);
  assert.match(mainSource, /maxConcurrentSessions:\s*DEFAULT_RUNTIME_SESSION_CONCURRENCY/);
  assert.doesNotMatch(mainSource, /maxConcurrent:\s*1/);
  assert.match(preloadSource, /startRuntimeTurn/);
  assert.match(preloadSource, /cancelRuntimeTurn/);
  assert.match(globalTypesSource, /interface RuntimeTurnStartPayload/);
  assert.match(globalTypesSource, /interface RuntimeOrchestratorSnapshot/);
  assert.match(globalTypesSource, /runtimeThreadId\?: string/);

  const sendPromptMatch = appSource.match(/const sendPrompt = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[[^\]]+\]\);/);
  assert.ok(sendPromptMatch, "sendPrompt callback should exist");
  assert.match(sendPromptMatch[1], /if \(activeSessionBusy\) return/);
  assert.match(sendPromptMatch[1], /await desktop\.startRuntimeTurn\(\{/);
  assert.match(sendPromptMatch[1], /conversationId:\s*targetSessionId/);
  assert.match(sendPromptMatch[1], /workspacePath:\s*settings\.workspacePath/);
  assert.match(sendPromptMatch[1], /mode:\s*launchAction/);
  assert.match(sendPromptMatch[1], /replyMessageId/);
  assert.doesNotMatch(sendPromptMatch[1], /await launch\(/);
});

test("home composer shows stop only for the active conversation and allows other sessions to send", () => {
  assert.match(appSource, /const activeSessionRuntimeTurns = useMemo/);
  assert.match(appSource, /turn\.conversationId === conversationStore\.activeSessionId/);
  assert.match(appSource, /const activeSessionBusy = activeSessionRuntimeTurns\.length > 0 \|\| activeSessionTerminalRunning/);
  assert.match(appSource, /const activeSessionRunningReplyIds = useMemo/);

  const inputMatch = appSource.match(/<div className="composer-input">([\s\S]*?)<\/div>/);
  assert.ok(inputMatch, "composer input markup should exist");
  assert.match(inputMatch[1], /activeSessionBusy \? \(/);
  assert.match(inputMatch[1], /onClick=\{stop\}/);
  assert.match(inputMatch[1], /<Square size=\{18\} aria-hidden \/>/);
  assert.match(inputMatch[1], /t\.composer\.stop/);
  assert.match(inputMatch[1], /disabled=\{activeSessionBusy \|\| !agentPrompt\.trim\(\)\}/);
  assert.doesNotMatch(inputMatch[1], /appRunning \? \(/);
});

test("runtime event effects do not read conversation store callbacks before initialization", () => {
  const callbackIndex = appSource.indexOf("const commitConversationStore = useCallback");
  const runtimeEffectIndex = appSource.indexOf("desktop.getRuntimeOrchestratorSnapshot()");
  assert.notEqual(callbackIndex, -1);
  assert.notEqual(runtimeEffectIndex, -1);
  assert.ok(callbackIndex < runtimeEffectIndex, "commitConversationStore must be initialized before runtime effects read it");
});

test("terminal controls remain available as the primary harness runtime path", () => {
  assert.match(preloadSource, /startTerminal/);
  assert.match(mainSource, /terminal:start/);
  assert.doesNotMatch(appSource, /fallbackTerminal/);
  assert.match(appSource, /streaming output|流式输出/i);
});

test("chat replies preserve substantial DeepSeek TUI output instead of compact status text", () => {
  assert.match(appSource, /function conversationAgentReply/);
  assert.match(appSource, /lines\.slice\(-28\)/);
  assert.match(appSource, /useful\.length > 2400/);
  assert.match(appSource, /title:\s*t\.runSummary\.title/);
  assert.match(appSource, /DeepSeek TUI Agent 正在读取 workspace、调用工具并处理这条任务/);
  assert.doesNotMatch(appSource, /compactAgentReply/);
  assert.doesNotMatch(appSource, /lines\.slice\(-4\)/);
  assert.doesNotMatch(appSource, /useful\.length > 360/);
});

test("sidebar avoids a separate Agents view while the chat status board handles zero counts", () => {
  const sidebarActionsMatch = appSource.match(/<section className="sidebar-actions">([\s\S]*?)<\/section>/);
  assert.ok(sidebarActionsMatch, "sidebar actions should exist");
  assert.doesNotMatch(sidebarActionsMatch[1], /mainView === "agents"/);
  assert.doesNotMatch(sidebarActionsMatch[1], /setMainView\("agents"\)/);
  assert.match(appSource, /runtimeSnapshot\.counts\.running/);
  assert.match(appSource, /t\.runtimeAgents\.noAgents/);
});
