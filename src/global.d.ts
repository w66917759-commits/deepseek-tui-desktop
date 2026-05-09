export {};

declare global {
  interface Window {
    deepseekDesktop: {
	      getSettings: () => Promise<DesktopSettings>;
	      openExternal: (url: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
	      checkDesktopUpdate: (options?: DesktopUpdateCheckOptions) => Promise<DesktopUpdateCheckResult>;
	      saveSettings: (settings: DesktopSettings) => Promise<DesktopSettings>;
	      getApiKey: (provider?: ProviderMode) => Promise<string>;
	      saveApiKey: (payload: ApiKeySavePayload) => Promise<ApiKeySaveResult>;
	      getCustomization: (settings: DesktopSettings) => Promise<CustomizationDraft>;
      createSkillTemplate: (payload: SkillCreatePayload) => Promise<TemplateSaveResult>;
	      importSkillDirectory: (payload: SkillImportPayload) => Promise<SkillImportResult>;
	      saveMcpConfig: (payload: McpConfigSavePayload) => Promise<McpConfigSaveResult>;
	      saveMcpEnvSecret: (payload: McpEnvSecretSavePayload) => Promise<McpEnvSecretSaveResult>;
	      testMcpServers: (payload: McpTestPayload) => Promise<McpTestResult>;
      getConversationHistory: () => Promise<ConversationStore>;
      saveConversationHistory: (history: ConversationStore) => Promise<ConversationStore>;
      getAutomations: () => Promise<AutomationStore>;
      saveAutomation: (payload: AutomationSavePayload) => Promise<AutomationActionResult>;
      deleteAutomation: (payload: AutomationIdPayload) => Promise<AutomationActionResult>;
      installAutomation: (payload: AutomationRunPayload) => Promise<AutomationActionResult>;
      uninstallAutomation: (payload: AutomationRunPayload) => Promise<AutomationActionResult>;
      chooseDirectory: () => Promise<string>;
      chooseFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string>;
	      openWorkspaceEditor: (options: OpenWorkspaceEditorOptions) => Promise<OpenWorkspaceEditorResult>;
	      checkRuntime: (settings?: Partial<DesktopSettings>) => Promise<RuntimeCheck>;
	      getRuntimeSnapshot: () => Promise<RuntimeSnapshot>;
	      getRuntimeOrchestratorSnapshot: () => Promise<RuntimeOrchestratorSnapshot>;
	      startRuntimeTurn: (payload: RuntimeTurnStartPayload) => Promise<RuntimeTurnStartResult>;
	      cancelRuntimeTurn: (payload: RuntimeTurnCancelPayload) => Promise<RuntimeTurnCancelResult>;
	      getRuntimeApiStatus: (settings?: DesktopSettings) => Promise<RuntimeApiStatus>;
	      getRuntimeApiInfo: (settings?: DesktopSettings) => Promise<RuntimeApiInfoResult>;
	      listRuntimeApiSkills: (settings?: DesktopSettings) => Promise<RuntimeApiSkillsResult>;
	      setRuntimeApiSkillEnabled: (payload: RuntimeApiSkillTogglePayload) => Promise<RuntimeApiSkillActionResult>;
	      listRuntimeApiMcpServers: (settings?: DesktopSettings) => Promise<RuntimeApiMcpServersResult>;
	      decideRuntimeApiApproval: (payload: RuntimeApiApprovalDecisionPayload) => Promise<RuntimeApiActionResult>;
	      getGitStatus: (workspacePath: string) => Promise<GitStatus>;
      initGitRepository: (workspacePath: string) => Promise<GitActionResult>;
      setGitRemote: (payload: GitRemotePayload) => Promise<GitActionResult>;
      switchGitBranch: (payload: GitBranchSwitchPayload) => Promise<GitActionResult>;
      fetchGitRepository: (payload: GitWorkspacePayload) => Promise<GitActionResult>;
      pullGitRepository: (payload: GitWorkspacePayload) => Promise<GitActionResult>;
      pushGitRepository: (payload: GitWorkspacePayload) => Promise<GitActionResult>;
      commitGitRepository: (payload: GitCommitPayload) => Promise<GitActionResult>;
      getGitDiffSummary: (payload: GitWorkspacePayload) => Promise<GitDiffSummaryResult>;
      startTerminal: (options: LaunchOptions) => Promise<{ ok: boolean; error?: string; runtime?: RuntimeCheck; pid?: number }>;
      stopTerminal: () => Promise<{ ok: boolean }>;
      sendTerminalInput: (data: string) => void;
      resizeTerminal: (size: { cols: number; rows: number }) => void;
      getRemoteStatus: () => Promise<RemoteBridgeStatus>;
      restartRemoteBridge: () => Promise<RemoteBridgeStatus>;
      rotateRemoteToken: () => Promise<{ settings: DesktopSettings; status: RemoteBridgeStatus }>;
      loginRemoteAccount: (payload: RemoteLoginPayload) => Promise<RemoteAuthResult>;
      logoutRemoteAccount: () => Promise<RemoteAuthResult>;
      startRemotePairing: () => Promise<RemotePairingResult>;
      revokeRemoteDevice: (deviceId: string) => Promise<RemoteAuthResult>;
      pushUpdateNotice: (payload: UpdatePushPayload) => Promise<{ ok: boolean; error?: string; notice?: UpdateNotice }>;
	      onTerminalData: (callback: (data: string) => void) => () => void;
	      onTerminalExit: (callback: (exit: { exitCode: number; signal?: number }) => void) => () => void;
	      onRuntimeSnapshot: (callback: (snapshot: RuntimeSnapshot) => void) => () => void;
	      onRuntimeEvent: (callback: (event: RuntimeEvent) => void) => () => void;
	      onRuntimeOrchestratorSnapshot: (callback: (snapshot: RuntimeOrchestratorSnapshot) => void) => () => void;
	      onRuntimeTurnEvent: (callback: (event: RuntimeTurnEvent) => void) => () => void;
	      onRuntimeApiStatus: (callback: (status: RuntimeApiStatus) => void) => () => void;
	      onRemoteStatus: (callback: (status: RemoteBridgeStatus) => void) => () => void;
	      onDesktopUpdateAvailable: (callback: (update: DesktopUpdateInfo) => void) => () => void;
	    };
  }

  type LaunchAction = "tui" | "continue" | "doctor" | "setup" | "mcp-init" | "sessions" | "exec" | "plan" | "yolo";
  type BinaryMode = "bundled" | "system" | "custom";
  type ProviderMode = "deepseek" | "nvidia-nim";
  type AppLanguage = "zh" | "en";
  type WorkspaceEditor = "cursor" | "vscode";
  type AutomationFrequency = "hourly" | "daily" | "weekly" | "custom";
  type AutomationStatus = "ACTIVE" | "PAUSED";

  interface DesktopUpdateCheckOptions {
    silent?: boolean;
  }

  interface DesktopUpdateInfo {
    currentVersion: string;
    version: string;
    tagName: string;
    name: string;
    releaseUrl: string;
    downloadUrl: string;
    assetName: string;
    publishedAt: string;
  }

  interface DesktopUpdateCheckResult {
    ok: boolean;
    currentVersion: string;
    update: DesktopUpdateInfo | null;
    error?: string;
  }

  interface OpenWorkspaceEditorOptions {
    editor: WorkspaceEditor;
    workspacePath: string;
  }

	  interface OpenWorkspaceEditorResult {
	    ok: boolean;
	    editor?: WorkspaceEditor;
	    path?: string;
	    command?: string;
	    error?: string;
	  }

	  interface ApiKeySavePayload {
	    provider: ProviderMode;
	    apiKey: string;
	  }

	  interface ApiKeySaveResult {
	    ok: boolean;
	    provider: ProviderMode;
	    hasKey: boolean;
	    error?: string;
	  }

  interface DesktopSettings {
    language: AppLanguage;
    workspacePath: string;
    binaryMode: BinaryMode;
    customBinaryPath: string;
    provider: ProviderMode;
    model: string;
    baseUrl: string;
    mcpConfigPath: string;
    skillsDir: string;
    skillsEnabled: boolean;
    mcpEnabled: boolean;
    allowShell: boolean;
    maxSubagents: number;
    processStreamEnabled: boolean;
    harnessEnabled: boolean;
    launchAction: LaunchAction;
    rememberWorkspace: boolean;
    enabledSkills: string[];
    enabledMcpServers: string[];
    mobileBridgeEnabled: boolean;
    mobileBridgeHost: string;
    mobileBridgePort: number;
    mobileBridgeToken: string;
    mobileRemoteControlEnabled: boolean;
    updatePushEnabled: boolean;
  }

  interface SkillTemplateDraft {
    id: string;
    name: string;
    description: string;
    path: string;
    source: "default" | "file";
    origin: "preset" | "custom";
    content: string;
  }

  interface CustomizationDraft {
    skillRoot: string;
    skillTemplates: Record<string, SkillTemplateDraft>;
    mcpConfigPath: string;
    mcpConfigSource: "generated" | "custom" | "missing";
    mcpConfigText: string;
    mcpConfigError?: string;
  }

  interface SkillCreatePayload {
    settings: DesktopSettings;
    skillId?: string;
    name?: string;
    description?: string;
    content?: string;
  }

  interface SkillImportPayload {
    settings: DesktopSettings;
    sourcePath: string;
  }

  interface TemplateSaveResult {
    ok: boolean;
    error?: string;
    skill?: SkillTemplateDraft;
    path?: string;
    skillRoot?: string;
  }

  interface SkillImportResult {
    ok: boolean;
    error?: string;
    skills?: SkillTemplateDraft[];
    path?: string;
    skillRoot?: string;
  }

  interface McpConfigSavePayload {
    settings: DesktopSettings;
    content: string;
  }

	  interface McpConfigSaveResult {
	    ok: boolean;
	    error?: string;
	    path?: string;
	    content?: string;
	  }

	  interface McpEnvSecretSavePayload {
	    name: string;
	    value: string;
	  }

	  interface McpEnvSecretSaveResult {
	    ok: boolean;
	    key?: string;
	    configured?: boolean;
	    source?: "desktop" | "environment" | "missing";
	    error?: string;
	  }

	  interface McpTestPayload {
	    settings: DesktopSettings;
	  }

	  type McpAdapterStatus = "ready" | "needs-auth" | "needs-config" | "command-missing" | "invalid-url";

		  interface McpServerTest {
		    id: string;
		    command: string;
		    args: string[];
		    url?: string;
		    ok: boolean;
		    injectable: boolean;
		    status: McpAdapterStatus;
		    commandFound: boolean;
    missingEnv: string[];
    warnings: string[];
    error?: string;
  }

  interface McpTestResult {
    ok: boolean;
    testedAt: string;
    configPath?: string;
    servers: McpServerTest[];
    error?: string;
  }

  interface LaunchOptions extends DesktopSettings {
    apiKey?: string;
    agentPrompt?: string;
    cols?: number;
    rows?: number;
  }

  interface ConversationMessage {
    id: string;
    role: "assistant" | "user";
    title?: string;
    content: string;
  }

  interface ConversationSession {
    id: string;
    projectId: string;
    projectName: string;
    workspacePath: string;
    runtimeThreadId?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: ConversationMessage[];
  }

  interface ConversationProject {
    id: string;
    name: string;
    workspacePath: string;
    sessions: ConversationSession[];
  }

  interface ConversationStore {
    activeSessionId: string;
    projects: ConversationProject[];
  }

  interface AutomationTask {
    id: string;
    kind: "cron";
    name: string;
    prompt: string;
    workspacePath: string;
    frequency: AutomationFrequency;
    minute: number;
    hour: number;
    weekday: number;
    customSchedule: string;
    schedule: string;
    rrule: string;
    timezone: string;
    status: AutomationStatus;
    enabled: boolean;
    installed: boolean;
    cronPath: string;
    logPath: string;
    commandPreview: string;
    runtimePath: string;
    runnerPath: string;
    runArgs: string[];
    provider: ProviderMode;
    model: string;
    baseUrl: string;
    mcpConfigPath: string;
    skillsDir: string;
    enabledSkills: string[];
    mcpEnabled: boolean;
    enabledMcpServers: string[];
    allowShell: boolean;
    maxSubagents: number;
    error?: string;
    createdAt: string;
    updatedAt: string;
    lastGeneratedAt: string;
    lastInstalledAt: string;
  }

  interface AutomationStore {
    version: number;
    tasks: AutomationTask[];
  }

  interface AutomationSavePayload {
    settings: DesktopSettings;
    task: Partial<AutomationTask>;
  }

  interface AutomationIdPayload {
    id: string;
  }

  interface AutomationRunPayload extends AutomationIdPayload {
    settings: DesktopSettings;
  }

  interface AutomationActionResult {
    ok: boolean;
    error?: string;
    task?: AutomationTask;
    tasks: AutomationTask[];
  }

	  interface RuntimeCheck {
	    selected: string;
    selectedExists: boolean;
    bundled: string;
    bundledExists: boolean;
    system: string;
    systemExists: boolean;
    custom: string;
    customExists: boolean;
	    version: string;
	  }

	  type RuntimeRunStatus = "idle" | "running" | "completed" | "failed" | "stopped";
	  type RuntimeAgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

	  interface RuntimeAgent {
	    id: string;
	    name: string;
	    status: RuntimeAgentStatus;
	    summary: string;
	    source: "pty" | "runtime-api";
	    createdAt: string;
	    updatedAt: string;
	  }

	  interface RuntimeEvent {
	    id: string;
	    type: string;
	    label: string;
	    detail: string;
	    at: string;
	  }

	  interface RuntimeSnapshot {
	    status: RuntimeRunStatus;
	    source: "none" | "pty" | "runtime-api";
	    sessionId: string;
	    mode: string;
	    workspacePath: string;
	    pid: number;
	    command: string;
	    args: string[];
	    startedAt: string;
	    updatedAt: string;
	    lastExit: { exitCode: number; signal?: string; exitedAt: string } | null;
	    agents: RuntimeAgent[];
	    counts: {
	      total: number;
	      running: number;
	      completed: number;
	      failed: number;
	      cancelled: number;
	    };
	    events: RuntimeEvent[];
	  }

	  type RuntimeTurnStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

	  interface RuntimeTurnStartPayload {
	    conversationId: string;
	    workspacePath: string;
	    prompt: string;
	    model?: string;
	    replyMessageId?: string;
	    mode?: string;
	    settings?: Partial<DesktopSettings>;
	  }

	  interface RuntimeTurnStartResult {
	    ok: boolean;
	    queued?: boolean;
	    turnId?: string;
	    conversationId?: string;
	    threadId?: string;
	    snapshot?: RuntimeOrchestratorSnapshot;
	    error?: string;
	    runtime?: RuntimeCheck;
	  }

	  interface RuntimeTurnCancelPayload {
	    conversationId?: string;
	    turnId?: string;
	  }

	  interface RuntimeTurnCancelResult {
	    ok: boolean;
	    cancelled: number;
	    snapshot: RuntimeOrchestratorSnapshot;
	  }

	  interface RuntimeTurn {
	    turnId: string;
	    conversationId: string;
	    threadId: string;
	    status: RuntimeTurnStatus;
	    prompt: string;
	    output: string;
	    error: string;
	    queuedAt: string;
	    startedAt: string;
	    completedAt: string;
	    replyMessageId: string;
	    queuePosition: number;
	  }

	  interface RuntimeConversationState {
	    conversationId: string;
	    workspacePath: string;
	    threadId: string;
	    activeTurnId: string;
	    queuedTurnIds: string[];
	    status: "idle" | "queued" | "running" | "cancelling";
	    updatedAt: string;
	  }

	  interface RuntimeOrchestratorSnapshot {
	    status: "idle" | "queued" | "running";
	    maxConcurrent: number;
	    maxConcurrentSessions?: number;
	    activeCount: number;
	    queueDepth: number;
	    counts: {
	      total: number;
	      queued: number;
	      running: number;
	      cancelling: number;
	      completed: number;
	      failed: number;
	      cancelled: number;
	    };
	    conversations: RuntimeConversationState[];
	    turns: RuntimeTurn[];
	    events: RuntimeEvent[];
	  }

	  interface RuntimeTurnEvent extends Partial<RuntimeTurn> {
	    type?: string;
	    event?: string;
	    at?: string;
	    detail?: string;
	    delta?: string;
	    message?: string;
	    source?: string;
	  }

	  type RuntimeApiConnectionState = "idle" | "starting" | "connected" | "error" | "stopped";

	  interface RuntimeApiInfo {
	    bind_host?: string;
	    port?: number;
	    auth_required?: boolean;
	    version?: string;
	    [key: string]: unknown;
	  }

	  interface RuntimeApiHealth {
	    status?: string;
	    service?: string;
	    mode?: string;
	    [key: string]: unknown;
	  }

	  interface RuntimeApiApproval {
	    id?: string;
	    approvalId?: string;
	    title?: string;
	    message?: string;
	    action?: string;
	    [key: string]: unknown;
	  }

	  interface RuntimeApiStatus {
	    state: RuntimeApiConnectionState;
	    connected: boolean;
	    host: string;
	    port: number;
	    url: string;
	    pid: number;
	    startedAt: string;
	    updatedAt: string;
	    error: string;
	    info: RuntimeApiInfo | null;
	    health: RuntimeApiHealth | null;
	    lastStdout: string;
	    lastStderr: string;
	    pendingApprovals: RuntimeApiApproval[];
	  }

	  interface RuntimeApiInfoResult {
	    ok: boolean;
	    info?: RuntimeApiInfo;
	    error?: string;
	  }

	  interface RuntimeApiSkill {
	    id: string;
	    name: string;
	    enabled: boolean;
	    description?: string;
	    path?: string;
	    [key: string]: unknown;
	  }

	  interface RuntimeApiSkillsResult {
	    ok: boolean;
	    directory?: string;
	    warnings: string[];
	    skills: RuntimeApiSkill[];
	    error?: string;
	  }

	  interface RuntimeApiSkillTogglePayload {
	    name: string;
	    enabled: boolean;
	    settings?: DesktopSettings;
	  }

	  interface RuntimeApiSkillActionResult {
	    ok: boolean;
	    skill?: RuntimeApiSkill;
	    error?: string;
	    result?: unknown;
	  }

	  interface RuntimeApiMcpServer {
	    id: string;
	    name: string;
	    enabled: boolean;
	    status?: string;
	    command?: string;
	    url?: string;
	    [key: string]: unknown;
	  }

	  interface RuntimeApiMcpServersResult {
	    ok: boolean;
	    servers: RuntimeApiMcpServer[];
	    error?: string;
	    result?: unknown;
	  }

	  interface RuntimeApiApprovalDecisionPayload {
	    approvalId: string;
	    decision: "allow" | "deny";
	    remember?: boolean;
	    settings?: DesktopSettings;
	  }

	  interface RuntimeApiActionResult {
	    ok: boolean;
	    error?: string;
	    result?: unknown;
	  }

  interface GitRemoteInfo {
    name: string;
    fetchUrl: string;
    pushUrl: string;
  }

  interface GitBranchInfo {
    name: string;
    type: "local" | "remote";
    current: boolean;
    upstream: string;
    commit: string;
    subject: string;
  }

  interface GitChangeInfo {
    status: string;
    path: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
  }

  interface GitStatus {
    ok: boolean;
    error?: string;
    workspacePath: string;
    repoRoot: string;
    isRepo: boolean;
    branch: string;
    upstream: string;
    ahead: number;
    behind: number;
    hasChanges: boolean;
    staged: number;
    unstaged: number;
    untracked: number;
    branches: GitBranchInfo[];
    remotes: GitRemoteInfo[];
    originUrl: string;
    lastCommit: {
      hash: string;
      subject: string;
      author: string;
      date: string;
    } | null;
    changes: GitChangeInfo[];
  }

  interface GitWorkspacePayload {
    workspacePath: string;
  }

  interface GitRemotePayload extends GitWorkspacePayload {
    remoteUrl: string;
  }

  interface GitBranchSwitchPayload extends GitWorkspacePayload {
    branchName: string;
  }

  interface GitCommitPayload extends GitWorkspacePayload {
    message: string;
  }

  interface GitActionResult {
    ok: boolean;
    error?: string;
    output?: string;
    status?: GitStatus;
  }

  interface GitDiffSummaryResult {
    ok: boolean;
    error?: string;
    output?: string;
    status?: GitStatus;
  }

  interface RemoteBridgeStatus {
    enabled: boolean;
    running: boolean;
    error: string;
    bindHost: string;
    port: number;
    localUrl: string;
    lanUrl: string;
    token?: string;
    tokenPreview: string;
    mobileRemoteControlEnabled: boolean;
    updatePushEnabled: boolean;
    auth: RemoteAuthState;
    sseClients: number;
    terminalPreview: string;
    lastTerminalAt: string;
    lastUpdateNotice: UpdateNotice | null;
    harness: {
      running: boolean;
      activeSession: {
        id: string;
        command: string;
        args: string[];
        cwd: string;
        pid: number;
        startedAt: string;
      } | null;
      lastExit: {
        exitCode?: number;
        signal?: number;
        exitedAt?: string;
      } | null;
    };
  }

  interface UpdatePushPayload {
    accountId?: string;
    email?: string;
    title?: string;
    body?: string;
    message?: string;
    version?: string;
    release?: string;
    url?: string;
    downloadUrl?: string;
  }

  interface UpdateNotice {
    id: string;
    source: string;
    accountId: string;
    matchedDeviceIds: string[];
    version: string;
    title: string;
    body: string;
    url: string;
    createdAt: string;
  }

  interface RemoteLoginPayload {
    accountId?: string;
    email?: string;
    displayName?: string;
    name?: string;
  }

  interface RemoteAuthAccount {
    accountId: string;
    email: string;
    displayName: string;
    loggedInAt: string;
  }

  interface RemotePairingState {
    active: boolean;
    codePreview: string;
    expiresAt: string;
    createdAt: string;
  }

  interface RemoteDevice {
    id: string;
    name: string;
    platform: string;
    accountId: string;
    pushProvider?: string;
    pushTokenPreview?: string;
    pairedAt: string;
    lastSeenAt: string;
    enabled?: boolean;
  }

  interface RemoteAuthState {
    desktopId: string;
    loggedIn: boolean;
    account: RemoteAuthAccount | null;
    pairing: RemotePairingState | null;
    devices: RemoteDevice[];
  }

  interface RemoteAuthResult {
    ok: boolean;
    error?: string;
    auth?: RemoteAuthState;
    status?: RemoteBridgeStatus;
  }

  interface RemotePairingResult extends RemoteAuthResult {
    pairing?: {
      code: string;
      codePreview: string;
      expiresAt: string;
      accountId: string;
      desktopId: string;
    };
  }
}
