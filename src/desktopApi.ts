const previewSettings: DesktopSettings = {
  language: "zh",
  workspacePath: "/Users/west/project",
  binaryMode: "bundled",
  customBinaryPath: "",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  baseUrl: "https://api.deepseek.com",
  mcpConfigPath: "",
  skillsDir: "",
  skillsEnabled: true,
  mcpEnabled: false,
  allowShell: false,
  layeredContextEnabled: true,
  contextVerbatimWindowTurns: 16,
  maxSubagents: 10,
  processStreamEnabled: true,
  thinkingMode: "max",
  skillRoutingMode: "auto",
  modelRoutingMode: "auto",
  harnessEnabled: false,
  launchAction: "tui",
  rememberWorkspace: true,
  enabledSkills: ["superpowers", "ui-ux-pro-max", "scheduled-task-agent", "cron-scheduler", "skill-downloader"],
  enabledMcpServers: [],
  mobileBridgeEnabled: false,
  mobileBridgeHost: "127.0.0.1",
  mobileBridgePort: 8765,
  mobileBridgeToken: "browser-preview-token",
  mobileRelayUrl: "https://deepseektuidesktop.cn",
  mobileRemoteControlEnabled: false,
  updatePushEnabled: false
};

function previewDeepSeekApiModel(model: string) {
  if (model === "deepseek-v4-flash" || model === "deepseek-v4-flash-1m") {
    return "deepseek-v4-flash";
  }
  if (model === "deepseek-v4-pro" || model === "deepseek-v4-pro-1m") {
    return "deepseek-v4-pro";
  }
  if (model === "deepseek-chat" || model === "deepseek-reasoner") {
    return "deepseek-v4-flash";
  }
  return model || "deepseek-v4-pro";
}

function previewApiModel(provider: ProviderMode, model: string) {
  return provider === "nvidia-nim" ? model : previewDeepSeekApiModel(model);
}

const previewSkillTemplateDefaults: Record<string, string> = {
  superpowers: [
    "---",
    "name: superpowers",
    "description: Use for planning, task decomposition, code edits, MCP/tool readiness checks, verification, and concise final reporting.",
    "---",
    "",
    "# Superpowers",
    "",
    "Use this skill to keep desktop Agent work grounded in the user's real goal, the current workspace, and verified runtime state.",
    "",
    "## Workflow",
    "",
    "1. Identify the user's concrete goal, target workspace, and whether they asked for planning, implementation, or review.",
    "2. Inspect the relevant files or runtime state before making assumptions.",
    "3. Break the work into small reversible steps that match the existing codebase.",
    "4. Before relying on an external tool, distinguish selected, injected, authenticated, connected, and callable states.",
    "5. Verify changes with the narrowest useful command first, then broader checks when the change touches shared behavior.",
    "6. Report changed surfaces, verification evidence, blockers, and remaining risk.",
    "",
    "## MCP Boundaries",
    "",
    "- Treat MCP selection in the UI as intent only; it does not prove the MCP is callable.",
    "- Treat launch-time injection as allowed only when adapter preflight reports the MCP as ready.",
    "- If a server is missing authentication, has a placeholder URL, or has a missing command, say it is blocked and use another available tool.",
    "- Never claim GitHub, Slack, Notion, Figma, database, payment, or remote MCP access is available until preflight or an actual tool call proves it.",
    "- Do not write API keys or tokens into Skill files, prompts, logs, generated docs, or MCP JSON examples.",
    "",
    "## Output",
    "",
    "- Keep user updates short and factual.",
    "- When blocked, name the missing credential or configuration and the exact next action.",
    "- When complete, separate verified behavior from unverified or skipped checks."
  ].join("\n"),
  "ui-ux-pro-max": [
    "---",
    "name: ui-ux-pro-max",
    "description: Use when designing, building, or refining frontend UI/UX: layouts, components, visual systems, typography, color, and UX patterns.",
    "---",
    "",
    "# UI/UX Pro Max - Design Intelligence",
    "",
    "Searchable design intelligence for styles, color palettes, font pairings, chart types, product recommendations, UX guidelines, and stack-specific best practices.",
    "",
    "## How to Use This Skill",
    "",
    "- In the packaged app, run `python3 scripts/search.py \"<keyword>\" --domain <domain>` from `$DEEPSEEK_SKILLS_DIR/ui-ux-pro-max`.",
    "- Search product, style, typography, color, landing, chart, UX, and stack guidance before implementing substantial UI work.",
    "- Infer the stack from the project when the user does not specify one.",
    "",
    "## State Clarity",
    "",
    "- Do not collapse different states into one label. Separate selected, saved, injected, authenticated, connected, callable, failed, and disabled.",
    "- For MCP and other external tools, show blocked states near the action that would otherwise imply availability.",
    "- A missing credential, placeholder URL, invalid URL, or missing command should read as blocked and should explain the exact missing piece.",
    "- Keep status chips short and pair them with concise helper text when the consequence matters."
  ].join("\n"),
  "scheduled-task-agent": [
    "---",
    "name: scheduled-task-agent",
    "description: Use when the user asks to create, plan, write, schedule, run later, repeat, remind, cron, launchd, background task, automation, recurring job, 定时任务, 自动任务, 提醒, 每天, 每小时, or 稍后执行 inside DeepSeek TUI Desktop.",
    "---",
    "",
    "# Scheduled Task Agent",
    "",
    "Use this skill for normal scheduled-task requests in DeepSeek TUI Desktop.",
    "",
    "## Tool Contract",
    "",
    "- For normal scheduled-task requests, call the built-in `automation_create` tool.",
    "- Use `automation_list`, `automation_pause`, and `automation_delete` when the user asks to inspect, pause, or remove scheduled tasks.",
    "- Only use the advanced `cron-scheduler` Skill when the user explicitly asks for a raw cron file or crontab snippet.",
    "- Do not ask the user to manually open the Scheduled Tasks page when the task can be created from the conversation.",
    "",
    "## Workflow",
    "",
    "1. Normalize the request into: task goal, Agent prompt, workspace, local wall-clock time, timezone, and active/paused status.",
    "2. If the task goal, workspace, hour, or minute is missing, ask only for the missing fields.",
    "3. If enough information is present, call `automation_create` with `prompt`, `workspacePath`, `hour`, `minute`, optional `name`, optional `timezone`, and `status` (default `ACTIVE`).",
    "4. After the tool returns, report the task id, activation status, cron path, log path, and any error.",
    "5. If the tool reports a credential or runtime problem, tell the user the exact missing piece instead of writing a separate cron file."
  ].join("\n"),
  "cron-scheduler": [
    "---",
    "name: cron-scheduler",
    "description: Advanced-only helper for hand-authored crontab files. Normal scheduled tasks are handled by the Scheduled Task Agent Skill.",
    "---",
    "",
    "# Cron Advanced Scripts",
    "",
    "Use this skill only when the user explicitly asks for a raw cron file or crontab snippet. For normal recurring Agent tasks, use the Scheduled Task Agent Skill.",
    "",
    "- Treat this as an advanced escape hatch, not the default scheduled-task workflow.",
    "- Generate and validate a cron file before discussing installation.",
    "- Do not run `crontab`, overwrite an existing crontab, or install a task unless the user explicitly asks.",
    "- Prefer outputs under `.deepseek/cron/` and logs under `.deepseek/logs/`.",
    "- Run `node \"$DEEPSEEK_SKILLS_DIR/cron-scheduler/scripts/write-cron-file.mjs\" --name \"daily-health-check\" --schedule \"0 5 * * *\" --command \"npm run health:check\" --cwd \"$PWD\" --timezone \"Asia/Shanghai\"`.",
    "- Report the generated file path, schedule, command, log path, and whether installation was skipped."
  ].join("\n"),
  "skill-downloader": [
    "---",
    "name: skill-downloader",
    "description: Use when the user asks to download, install, import, fetch, or update a Skill from a URL, GitHub raw file, local path, or archive.",
    "---",
    "",
    "# Skill Downloader",
    "",
    "Use this skill when a user asks to download or install a Skill during a desktop Agent conversation.",
    "",
    "- Do not synthesize remote Skill content. Download or copy the source bytes first, then verify the saved file.",
    "- Prefer `curl -fsSL \"<skill-url>\" -o \".deepseek/skills/<skill-id>/SKILL.md\"` for URL sources.",
    "- Verify with `test -s` and inspect the first lines for `name:` and `description:` frontmatter.",
    "- Report the source URL, destination path, and verification result."
  ].join("\n")
};

let previewSkillTemplates: Record<string, string> = { ...previewSkillTemplateDefaults };
let previewMcpConfigPath = "";
let previewMcpConfigText = "";
let previewApiKeys: Record<ProviderMode, string> = {
  deepseek: "",
  "nvidia-nim": ""
};
let previewMcpEnv: Record<string, string> = {};
let previewGitBranch = "main";

let previewRuntimeSnapshot: RuntimeSnapshot = {
  status: "idle",
  source: "none",
  sessionId: "",
  mode: "",
  workspacePath: "",
  pid: 0,
  command: "",
  args: [],
  startedAt: "",
  updatedAt: new Date().toISOString(),
  lastExit: null,
  agents: [],
  counts: {
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  },
  events: []
};

let previewRuntimeOrchestratorSnapshot: RuntimeOrchestratorSnapshot = {
  status: "idle",
  maxConcurrent: 8,
  maxConcurrentSessions: 8,
  activeCount: 0,
  queueDepth: 0,
  counts: {
    total: 0,
    queued: 0,
    running: 0,
    cancelling: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  },
  conversations: [],
  turns: [],
  events: []
};

let previewRuntimeApiStatus: RuntimeApiStatus = {
  state: "connected",
  connected: true,
  host: "127.0.0.1",
  port: 7878,
  url: "http://127.0.0.1:7878",
  pid: 7878,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  error: "",
  info: {
    bind_host: "127.0.0.1",
    port: 7878,
    auth_required: true,
    version: "0.8.36"
  },
  health: {
    status: "ok",
    service: "deepseek-runtime-api",
    mode: "local"
  },
  lastStdout: "Runtime API listening on http://127.0.0.1:7878",
  lastStderr: "",
  pendingApprovals: [],
  pendingUserInputs: []
};

function previewSkillName(id: string) {
  return id.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "Skill";
}

function previewSkillDescription(content: string) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const description = frontmatter?.[1]?.split(/\n/).find((line) => line.startsWith("description:"));
  if (description) return description.replace("description:", "").trim();
  return "Custom agent workflow skill.";
}

function previewSkillDraft(id: string, root: string, content: string, source: "default" | "file"): SkillTemplateDraft {
  return {
    id,
    name: previewSkillName(id),
    description: previewSkillDescription(content),
    path: `${root}/${id}/SKILL.md`,
    source,
    origin: previewSkillTemplateDefaults[id] ? "preset" : "custom",
    content
  };
}

function previewRuntimeApiSkills(settings: DesktopSettings): RuntimeApiSkill[] {
  const root = "/browser-preview/userData/skills";
  const ids = Array.from(new Set([
    ...Object.keys(previewSkillTemplateDefaults),
    ...Object.keys(previewSkillTemplates)
  ]));
  return ids.map((id) => {
    const content = previewSkillTemplates[id] || previewSkillTemplateDefaults[id] || "";
    const draft = previewSkillDraft(id, root, content, previewSkillTemplates[id] ? "file" : "default");
    return {
      id,
      name: draft.name,
      description: draft.description,
      path: draft.path,
      enabled: settings.skillsEnabled !== false && settings.enabledSkills.includes(id)
    };
  });
}

function previewRuntimeApiMcpServers(settings: DesktopSettings): RuntimeApiMcpServer[] {
  return previewMcpTests(settings).map((server) => ({
    id: server.id,
    name: previewSkillName(server.id),
    enabled: server.injectable,
    status: server.status,
    command: [server.command, ...server.args].filter(Boolean).join(" "),
    url: server.url || ""
  }));
}

function publishPreviewRuntimeApiStatus(listeners: Set<(status: RuntimeApiStatus) => void>) {
  previewRuntimeApiStatus = {
    ...previewRuntimeApiStatus,
    updatedAt: new Date().toISOString()
  };
  listeners.forEach((listener) => listener(previewRuntimeApiStatus));
}

let previewConversationStore: ConversationStore = {
  activeSessionId: "",
  projects: []
};

let previewAutomations: AutomationTask[] = [
  {
    id: "automation-preview-daily",
    kind: "cron",
    name: "每日项目巡检",
    prompt: "检查当前 workspace 的运行状态、待处理变更和潜在问题，输出简短日报。",
    workspacePath: previewSettings.workspacePath,
    frequency: "daily",
    minute: 0,
    hour: 9,
    weekday: 1,
    customSchedule: "0 9 * * *",
    schedule: "0 9 * * *",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    status: "ACTIVE",
    enabled: true,
    installed: true,
    cronPath: "/browser-preview/workspace/.deepseek/cron/daily-project-check.cron",
    logPath: "/browser-preview/workspace/.deepseek/logs/daily-project-check.log",
    commandPreview: "deepseek exec --auto '检查当前 workspace 的运行状态、待处理变更和潜在问题，输出简短日报。'",
    runtimePath: "browser-preview://deepseek",
    runnerPath: "",
    runArgs: [],
    provider: previewSettings.provider,
    model: previewSettings.model,
    baseUrl: previewSettings.baseUrl,
    mcpConfigPath: previewSettings.mcpConfigPath,
    skillsDir: previewSettings.skillsDir,
    enabledSkills: previewSettings.enabledSkills,
    mcpEnabled: previewSettings.mcpEnabled,
    enabledMcpServers: previewSettings.enabledMcpServers,
    allowShell: previewSettings.allowShell,
    maxSubagents: previewSettings.maxSubagents,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastGeneratedAt: new Date().toISOString(),
    lastInstalledAt: ""
  }
];

function previewSchedule(task: Partial<AutomationTask>) {
  const minute = Number(task.minute ?? 0);
  const hour = Number(task.hour ?? 9);
  return `${minute} ${hour} * * *`;
}

function previewRuntime(settings: Partial<DesktopSettings> = {}): RuntimeCheck {
  return {
    selected: "browser-preview://deepseek",
    selectedExists: true,
    bundled: "browser-preview://deepseek",
    bundledExists: true,
    system: "",
    systemExists: false,
    custom: settings.customBinaryPath || "",
    customExists: false,
    version: "Browser preview"
  };
}

function previewGitStatus(workspacePath: string): GitStatus {
  const branches: GitBranchInfo[] = [
    {
      name: "main",
      type: "local",
      current: previewGitBranch === "main",
      upstream: "origin/main",
      commit: "abc1234",
      subject: "Preview commit"
    },
    {
      name: "codex/preview-agent",
      type: "local",
      current: previewGitBranch === "codex/preview-agent",
      upstream: "",
      commit: "def5678",
      subject: "Preview branch"
    },
    {
      name: "origin/master",
      type: "remote",
      current: false,
      upstream: "",
      commit: "987abcd",
      subject: "Remote master"
    }
  ];

  return {
    ok: true,
    workspacePath: workspacePath || previewSettings.workspacePath,
    repoRoot: workspacePath || previewSettings.workspacePath,
    isRepo: true,
    branch: previewGitBranch,
    upstream: branches.find((branch) => branch.type === "local" && branch.name === previewGitBranch)?.upstream || "",
    ahead: 0,
    behind: 0,
    hasChanges: true,
    staged: 0,
    unstaged: 1,
    untracked: 1,
    branches,
    remotes: [
      {
        name: "origin",
        fetchUrl: "https://github.com/example/deepseek-tui-desktop.git",
        pushUrl: "https://github.com/example/deepseek-tui-desktop.git"
      }
    ],
    originUrl: "https://github.com/example/deepseek-tui-desktop.git",
    lastCommit: {
      hash: "abc1234",
      subject: "Preview commit",
      author: "DeepSeek TUI",
      date: "just now"
    },
    changes: [
      { status: " M", path: "src/App.tsx", staged: false, unstaged: true, untracked: false },
      { status: "??", path: "docs/git-notes.md", staged: false, unstaged: false, untracked: true }
    ]
  };
}

function previewMcpConfig(settings: DesktopSettings) {
  const servers = Object.fromEntries((settings.enabledMcpServers || []).map((id) => [
    id,
    {
      command: "npx",
      args: ["-y", id],
      env: {},
      disabled: false,
      enabled: true
    }
  ]));

  return {
    timeouts: {
      connect_timeout: 10,
      execute_timeout: 60,
      read_timeout: 120
    },
    servers
  };
}

function previewMcpStatus(id: string, missingEnv: string[], warnings: string[]): McpAdapterStatus {
  if (missingEnv.length > 0) return "needs-auth";
  if (warnings.length > 0 || (id === "mcp-remote" && !String(previewMcpEnv.MCP_REMOTE_URL || "").trim())) return "needs-config";
  return "ready";
}

function previewMcpTests(settings: DesktopSettings): McpServerTest[] {
  if (settings.mcpConfigPath && previewMcpConfigText) {
    try {
      const parsed = JSON.parse(previewMcpConfigText);
      const servers = parsed?.servers && typeof parsed.servers === "object" ? parsed.servers : {};
      return Object.entries(servers)
        .filter(([, server]) => (server as { disabled?: boolean; enabled?: boolean })?.disabled !== true && (server as { enabled?: boolean })?.enabled !== false)
        .map(([id, raw]) => {
          const server = raw as { command?: string; args?: unknown[]; env?: Record<string, string>; url?: string };
          const missingEnv = Object.entries(server.env || {})
            .filter(([, value]) => !String(value || "").trim())
            .map(([key]) => key);
          const hasUrl = Boolean(String(server.url || "").trim());
          const warnings = missingEnv.length ? [`Missing environment variables: ${missingEnv.join(", ")}`] : [];
          const status = previewMcpStatus(id, missingEnv, warnings);
          return {
            id,
            command: String(server.command || ""),
            args: Array.isArray(server.args) ? server.args.map(String) : [],
            url: String(server.url || ""),
            ok: (hasUrl || Boolean(server.command)) && status === "ready",
            injectable: (hasUrl || Boolean(server.command)) && status === "ready",
            status,
            commandFound: hasUrl || Boolean(server.command),
            missingEnv,
            warnings
          };
        });
    } catch {
      return [];
    }
  }
  return (settings.enabledMcpServers || []).map((id) => {
    const requiredEnv = id === "github"
      ? ["GITHUB_PERSONAL_ACCESS_TOKEN"]
      : id === "mcp-remote"
        ? ["MCP_REMOTE_URL"]
        : [];
    const missingEnv = requiredEnv.filter((key) => !String(previewMcpEnv[key] || "").trim());
    const warnings = missingEnv.length ? [`Missing environment variables: ${missingEnv.join(", ")}`] : [];
    const status = previewMcpStatus(id, missingEnv, warnings);
    return {
      id,
      command: "npx",
      args: ["-y", id],
      ok: status === "ready",
      injectable: status === "ready",
      status,
      commandFound: true,
      missingEnv,
      warnings
    };
  });
}

export function createPreviewBridge(): Window["deepseekDesktop"] {
  const listeners = new Set<(data: string) => void>();
  const exits = new Set<(exit: { exitCode: number; signal?: number }) => void>();
  const runtimeSnapshots = new Set<(snapshot: RuntimeSnapshot) => void>();
  const runtimeEvents = new Set<(event: RuntimeEvent) => void>();
  const runtimeOrchestratorSnapshots = new Set<(snapshot: RuntimeOrchestratorSnapshot) => void>();
  const runtimeTurnEvents = new Set<(event: RuntimeTurnEvent) => void>();
  const runtimeApiStatuses = new Set<(status: RuntimeApiStatus) => void>();
  const runtimeApiThreadEvents = new Set<(event: RuntimeApiThreadEventEnvelope) => void>();
  const remoteStatuses = new Set<(status: RemoteBridgeStatus) => void>();
  const desktopUpdateListeners = new Set<(update: DesktopUpdateInfo) => void>();
  const previewThreadDetails = new Map<string, RuntimeApiThreadDetail>();
  let previewThreadSeq = 1;
  let previewAuth: RemoteAuthState = {
    desktopId: "desktop_preview",
    loggedIn: false,
    account: null,
    pairing: null,
    devices: []
  };

  const previewRemoteStatus = (): RemoteBridgeStatus => ({
    enabled: previewSettings.mobileBridgeEnabled,
    running: previewSettings.mobileBridgeEnabled,
    error: "",
    bindHost: previewSettings.mobileBridgeHost,
    port: previewSettings.mobileBridgePort,
    localUrl: `http://127.0.0.1:${previewSettings.mobileBridgePort}`,
    lanUrl: `http://127.0.0.1:${previewSettings.mobileBridgePort}`,
    token: previewSettings.mobileBridgeToken,
    tokenPreview: "browser...oken",
    relay: {
      enabled: previewSettings.mobileBridgeEnabled,
      connected: previewSettings.mobileBridgeEnabled,
      url: previewSettings.mobileRelayUrl,
      sessionId: previewSettings.mobileBridgeEnabled ? "relay_preview" : "",
      lastConnectedAt: previewSettings.mobileBridgeEnabled ? new Date().toISOString() : "",
      lastError: ""
    },
    mobileRemoteControlEnabled: previewSettings.mobileRemoteControlEnabled,
    updatePushEnabled: previewSettings.updatePushEnabled,
    auth: previewAuth,
    sseClients: 0,
    terminalPreview: "",
    lastTerminalAt: "",
    lastUpdateNotice: null,
    harness: {
      running: false,
      activeSession: null,
      lastExit: null
    }
  });

  const ensurePreviewThread = (threadId?: string, workspacePath?: string): RuntimeApiThreadDetail => {
    const resolvedThreadId = threadId || `preview-thread-${Date.now().toString(36)}`;
    const existing = previewThreadDetails.get(resolvedThreadId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const detail: RuntimeApiThreadDetail = {
      thread: {
        id: resolvedThreadId,
        created_at: now,
        updated_at: now,
        model: previewSettings.model,
        workspace: workspacePath || previewSettings.workspacePath,
        mode: "agent",
        archived: false,
        title: "Preview Thread"
      },
      turns: [],
      items: [],
      latest_seq: 0
    };
    previewThreadDetails.set(resolvedThreadId, detail);
    return detail;
  };

  const publishPreviewThreadEvent = (threadId: string, event: RuntimeApiThreadEventRecord, detail: RuntimeApiThreadDetail) => {
    runtimeApiThreadEvents.forEach((listener) => listener({
      threadId,
      event,
      detail
    }));
  };

  return {
    getSettings: async () => previewSettings,
    openExternal: async (url) => {
      if (typeof window !== "undefined" && /^https?:\/\//i.test(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
        return { ok: true, url };
      }
      return { ok: false, error: "Invalid URL" };
    },
    checkDesktopUpdate: async () => ({
      ok: true,
      currentVersion: "0.1.6",
      update: null
    }),
    saveSettings: async (settings) => {
	      Object.assign(previewSettings, settings);
	      previewSettings.model = previewSettings.provider === "deepseek"
	        ? previewSettings.model || "deepseek-v4-pro"
	        : previewSettings.model;
	      const status = previewRemoteStatus();
	      remoteStatuses.forEach((listener) => listener(status));
	      return { ...previewSettings };
	    },
	    getApiKey: async (provider = "deepseek") => previewApiKeys[provider] || "",
	    saveApiKey: async (payload) => {
	      const provider = payload.provider === "nvidia-nim" ? "nvidia-nim" : "deepseek";
	      const apiKey = String(payload.apiKey || "").trim();
	      if (apiKey) {
	        previewApiKeys = { ...previewApiKeys, [provider]: apiKey };
	      }
	      return { ok: true, provider, hasKey: Boolean(previewApiKeys[provider]) };
	    },
	    getCustomization: async (settings) => {
      const nextSettings = { ...previewSettings, ...settings };
      const root = "/browser-preview/userData/skills";
      const skillIds = Array.from(new Set([
        ...Object.keys(previewSkillTemplateDefaults),
        ...Object.keys(previewSkillTemplates)
      ]));
      return {
        skillRoot: root,
        skillTemplates: Object.fromEntries(skillIds.map((id) => {
          const content = previewSkillTemplates[id] || previewSkillTemplateDefaults[id] || "";
          return [id, previewSkillDraft(id, root, content, previewSkillTemplates[id] ? "file" : "default")];
        })),
        mcpConfigPath: previewMcpConfigPath,
        mcpConfigSource: previewMcpConfigPath ? "custom" : "generated",
        mcpConfigText: previewMcpConfigText || JSON.stringify(previewMcpConfig(nextSettings), null, 2),
        mcpConfigError: ""
      };
    },
    createSkillTemplate: async (payload) => {
      const id = (payload.skillId || payload.name || `skill-${Date.now().toString(36)}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `skill-${Date.now().toString(36)}`;
      const content = payload.content || [
        "---",
        `name: ${id}`,
        `description: ${payload.description || `Use when ${payload.name || id} guidance is needed.`}`,
        "---",
        "",
        `# ${payload.name || previewSkillName(id)}`,
        "",
        "## Overview",
        "",
        "Describe the reusable workflow, trigger conditions, and verification steps for this skill."
      ].join("\n");
      previewSkillTemplates[id] = content;
      const root = "/browser-preview/userData/skills";
      return {
        ok: true,
        skill: previewSkillDraft(id, root, content, "file"),
        path: `${root}/${id}/SKILL.md`,
        skillRoot: root
      };
    },
    importSkillDirectory: async (payload) => {
      const id = payload.sourcePath.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "imported-skill";
      const content = [
        "---",
        `name: ${id}`,
        "description: Use when imported workflow guidance is needed.",
        "---",
        "",
        `# ${previewSkillName(id)}`,
        "",
        "Imported preview skill."
      ].join("\n");
      previewSkillTemplates[id] = content;
      const root = "/browser-preview/userData/skills";
      return {
        ok: true,
        skills: [previewSkillDraft(id, root, content, "file")],
        path: root,
        skillRoot: root
      };
    },
	    saveMcpConfig: async (payload) => {
	      try {
	        previewMcpConfigText = JSON.stringify(JSON.parse(payload.content), null, 2);
	      } catch (error) {
	        return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
	      }
	      previewMcpConfigPath = "/browser-preview/userData/mcp.custom.json";
	      return { ok: true, path: previewMcpConfigPath, content: previewMcpConfigText };
	    },
	    saveMcpEnvSecret: async (payload) => {
	      const key = String(payload.name || "").trim().toUpperCase();
	      if (!/^[A-Z0-9_]+$/.test(key)) {
	        return { ok: false, key, configured: false, source: "missing", error: "Environment variable name is invalid." };
	      }
	      const value = String(payload.value || "").trim();
	      if (value) {
	        previewMcpEnv = { ...previewMcpEnv, [key]: value };
	      } else {
	        const next = { ...previewMcpEnv };
	        delete next[key];
	        previewMcpEnv = next;
	      }
	      return { ok: true, key, configured: Boolean(previewMcpEnv[key]), source: previewMcpEnv[key] ? "desktop" : "missing" };
	    },
		    testMcpServers: async (payload) => {
	      const servers = previewMcpTests(payload.settings);
	      return {
	        ok: servers.every((server) => server.ok),
	        testedAt: new Date().toISOString(),
	        configPath: previewMcpConfigPath,
	        servers
	      };
	    },
    getConversationHistory: async () => previewConversationStore,
    saveConversationHistory: async (history) => {
      previewConversationStore = history;
      return previewConversationStore;
    },
    getAutomations: async () => ({ version: 1, tasks: previewAutomations }),
    saveAutomation: async (payload) => {
      const task = payload.task;
      const id = task.id || `automation-${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      const existing = previewAutomations.find((item) => item.id === id);
      const enabled = task.status === "PAUSED" ? false : task.enabled !== false;
      const saved: AutomationTask = {
        id,
        kind: "cron",
        name: task.name || "Scheduled Agent Task",
        prompt: task.prompt || "",
        workspacePath: task.workspacePath || payload.settings.workspacePath || previewSettings.workspacePath,
        frequency: task.frequency || "daily",
        minute: Number(task.minute ?? 0),
        hour: Number(task.hour ?? 9),
        weekday: Number(task.weekday ?? 1),
        customSchedule: task.customSchedule || "0 9 * * *",
        schedule: previewSchedule(task),
        timezone: task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        rrule: task.rrule || `FREQ=DAILY;BYHOUR=${Number(task.hour ?? 9)};BYMINUTE=${Number(task.minute ?? 0)}`,
        status: enabled ? "ACTIVE" : "PAUSED",
        enabled,
        installed: enabled,
        cronPath: `/browser-preview/workspace/.deepseek/cron/${id}.cron`,
        logPath: `/browser-preview/workspace/.deepseek/logs/${id}.log`,
        commandPreview: `browser-preview://deepseek exec --auto '${task.prompt || ""}'`,
        runtimePath: "browser-preview://deepseek",
        runnerPath: "",
        runArgs: [],
        provider: task.provider || payload.settings.provider || previewSettings.provider,
        model: previewApiModel(
          task.provider || payload.settings.provider || previewSettings.provider,
          task.model || payload.settings.model || previewSettings.model
        ),
        baseUrl: task.baseUrl || payload.settings.baseUrl || previewSettings.baseUrl,
        mcpConfigPath: task.mcpConfigPath || payload.settings.mcpConfigPath || "",
        skillsDir: task.skillsDir || payload.settings.skillsDir || "",
        enabledSkills: task.enabledSkills || payload.settings.enabledSkills || [],
        mcpEnabled: Boolean(task.mcpEnabled ?? payload.settings.mcpEnabled),
        enabledMcpServers: task.enabledMcpServers || payload.settings.enabledMcpServers || [],
        allowShell: Boolean(task.allowShell ?? payload.settings.allowShell),
        maxSubagents: Number(task.maxSubagents ?? payload.settings.maxSubagents ?? 0),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        lastGeneratedAt: now,
        lastInstalledAt: enabled ? existing?.lastInstalledAt || now : existing?.lastInstalledAt || ""
      };
      previewAutomations = [saved, ...previewAutomations.filter((item) => item.id !== id)];
      return { ok: true, task: saved, tasks: previewAutomations };
    },
    deleteAutomation: async (payload) => {
      previewAutomations = previewAutomations.filter((item) => item.id !== payload.id);
      return { ok: true, tasks: previewAutomations };
    },
    installAutomation: async (payload) => {
      const now = new Date().toISOString();
      previewAutomations = previewAutomations.map((item) => item.id === payload.id ? { ...item, installed: true, enabled: true, status: "ACTIVE", lastInstalledAt: now, updatedAt: now } : item);
      return { ok: true, task: previewAutomations.find((item) => item.id === payload.id), tasks: previewAutomations };
    },
    uninstallAutomation: async (payload) => {
      const now = new Date().toISOString();
      previewAutomations = previewAutomations.map((item) => item.id === payload.id ? { ...item, installed: false, enabled: false, status: "PAUSED", updatedAt: now } : item);
      return { ok: true, task: previewAutomations.find((item) => item.id === payload.id), tasks: previewAutomations };
    },
    chooseDirectory: async () => previewSettings.workspacePath,
    chooseFile: async () => "",
    openWorkspaceEditor: async (options) => options.workspacePath
      ? {
        ok: true,
        editor: options.editor,
        path: options.workspacePath,
        command: "browser-preview"
      }
      : {
        ok: false,
        error: "Choose a workspace before opening an editor."
      },
	    checkRuntime: async (settings) => previewRuntime(settings),
	    getRuntimeSnapshot: async () => previewRuntimeSnapshot,
	    getRuntimeOrchestratorSnapshot: async () => previewRuntimeOrchestratorSnapshot,
	    startRuntimeTurn: async (payload) => {
	      const now = new Date().toISOString();
	      const turnId = `preview-turn-${Date.now().toString(36)}`;
	      const conversationId = payload.conversationId || "preview-conversation";
	      const threadId = `preview-thread-${conversationId}`;
	      const streamChunks = [
	        "Preview runtime stream\n",
	        `Workspace: ${payload.workspacePath || previewSettings.workspacePath}\n`,
	        `Prompt: ${payload.prompt}\n`
	      ];
	      const output = streamChunks.join("").trim();
	      const runningTurn: RuntimeTurn = {
	        turnId,
	        conversationId,
	        threadId,
	        status: "running",
	        prompt: payload.prompt,
	        output: "",
	        error: "",
	        queuedAt: now,
	        startedAt: now,
	        completedAt: "",
	        replyMessageId: payload.replyMessageId || "",
	        queuePosition: 0
	      };
	      previewRuntimeOrchestratorSnapshot = {
	        ...previewRuntimeOrchestratorSnapshot,
	        status: "running",
	        activeCount: 1,
	        queueDepth: 0,
	        counts: {
	          total: previewRuntimeOrchestratorSnapshot.counts.total + 1,
	          queued: 0,
	          running: 1,
	          cancelling: 0,
	          completed: previewRuntimeOrchestratorSnapshot.counts.completed,
	          failed: 0,
	          cancelled: 0
	        },
	        conversations: [{
	          conversationId,
	          workspacePath: payload.workspacePath,
	          threadId,
	          activeTurnId: turnId,
	          queuedTurnIds: [],
	          status: "running",
	          updatedAt: now
	        }],
	        turns: [...previewRuntimeOrchestratorSnapshot.turns, runningTurn].slice(-50)
	      };
	      runtimeOrchestratorSnapshots.forEach((listener) => listener(previewRuntimeOrchestratorSnapshot));
	      runtimeTurnEvents.forEach((listener) => listener({ ...runningTurn, type: "turn-started", at: now }));
	      for (const chunk of streamChunks) {
	        runtimeTurnEvents.forEach((listener) => listener({
	          ...runningTurn,
	          type: "response_delta",
	          detail: chunk,
	          at: new Date().toISOString()
	        }));
	      }
	      const completedAt = new Date().toISOString();
	      const completedTurn: RuntimeTurn = {
	        ...runningTurn,
	        status: "completed",
	        output,
	        completedAt
	      };
	      previewRuntimeOrchestratorSnapshot = {
	        ...previewRuntimeOrchestratorSnapshot,
	        status: "idle",
	        activeCount: 0,
	        counts: {
	          ...previewRuntimeOrchestratorSnapshot.counts,
	          running: 0,
	          completed: previewRuntimeOrchestratorSnapshot.counts.completed + 1
	        },
	        conversations: previewRuntimeOrchestratorSnapshot.conversations.map((conversation) => conversation.conversationId === conversationId ? {
	          ...conversation,
	          activeTurnId: "",
	          status: "idle",
	          updatedAt: completedAt
	        } : conversation),
	        turns: previewRuntimeOrchestratorSnapshot.turns.map((turn) => turn.turnId === turnId ? completedTurn : turn)
	      };
	      runtimeOrchestratorSnapshots.forEach((listener) => listener(previewRuntimeOrchestratorSnapshot));
	      runtimeTurnEvents.forEach((listener) => listener({ ...completedTurn, type: "turn-completed", at: completedAt }));
	      return { ok: true, queued: false, turnId, conversationId, threadId, snapshot: previewRuntimeOrchestratorSnapshot };
	    },
	    cancelRuntimeTurn: async (payload) => {
	      const snapshot = {
	        ...previewRuntimeOrchestratorSnapshot,
	        turns: previewRuntimeOrchestratorSnapshot.turns.map((turn) => payload.turnId && turn.turnId !== payload.turnId ? turn : {
	          ...turn,
	          status: "cancelled" as RuntimeTurnStatus
	        })
	      };
	      previewRuntimeOrchestratorSnapshot = snapshot;
	      runtimeOrchestratorSnapshots.forEach((listener) => listener(snapshot));
	      return { ok: true, cancelled: 1, snapshot };
	    },
	    getRuntimeApiStatus: async () => {
	      publishPreviewRuntimeApiStatus(runtimeApiStatuses);
	      return previewRuntimeApiStatus;
	    },
	    getRuntimeApiInfo: async () => {
	      publishPreviewRuntimeApiStatus(runtimeApiStatuses);
	      return { ok: true, info: previewRuntimeApiStatus.info || undefined };
	    },
	    listRuntimeApiThreads: async () => ({
	      ok: true,
	      threads: Array.from(previewThreadDetails.values()).map((detail) => ({
	        id: detail.thread.id,
	        title: String(detail.thread.title || "Preview Thread"),
	        preview: detail.items.at(-1)?.detail || detail.turns.at(-1)?.input_summary || "Preview thread",
	        model: detail.thread.model,
	        mode: detail.thread.mode,
	        archived: Boolean(detail.thread.archived),
	        updated_at: String(detail.thread.updated_at || new Date().toISOString()),
	        latest_turn_id: detail.thread.latest_turn_id || null,
	        latest_turn_status: detail.turns.at(-1)?.status || null
	      }))
	    }),
	    createRuntimeApiThread: async (payload) => {
	      const detail = ensurePreviewThread(undefined, payload.workspacePath);
	      detail.thread.mode = payload.mode || detail.thread.mode;
	      detail.thread.model = payload.model || detail.thread.model;
	      detail.thread.workspace = payload.workspacePath || detail.thread.workspace;
	      previewThreadDetails.set(detail.thread.id, detail);
	      return { ok: true, thread: detail.thread };
	    },
	    getRuntimeApiThread: async (payload) => {
	      const detail = ensurePreviewThread(payload.threadId);
	      return { ok: true, detail };
	    },
	    startRuntimeApiThreadTurn: async (payload) => {
	      const detail = ensurePreviewThread(payload.threadId, payload.workspacePath);
	      const now = new Date().toISOString();
	      const threadId = detail.thread.id;
	      const turnId = `preview-turn-${Date.now().toString(36)}`;
	      const userItemId = `preview-item-user-${Date.now().toString(36)}`;
	      const assistantItemId = `preview-item-agent-${Date.now().toString(36)}`;
	      const turn: RuntimeApiTurnRecord = {
	        id: turnId,
	        thread_id: threadId,
	        status: "completed",
	        input_summary: payload.prompt,
	        created_at: now,
	        started_at: now,
	        ended_at: now,
	        duration_ms: 1,
	        usage: null,
	        error: null,
	        item_ids: [userItemId, assistantItemId],
	        steer_count: 0
	      };
	      const userItem: RuntimeApiItemRecord = {
	        id: userItemId,
	        turn_id: turnId,
	        kind: "user_message",
	        status: "completed",
	        summary: payload.prompt,
	        detail: payload.prompt,
	        metadata: null,
	        artifact_refs: [],
	        started_at: now,
	        ended_at: now
	      };
	      const previewAssistantDetail = /task decomposition planner/i.test(payload.prompt)
	        ? [
	          "```json",
	          JSON.stringify({
	            items: [
	              {
	                id: "inspect-flow",
	                title: "检查执行入口",
	                goal: "确认当前发送、路由和运行时调用入口。",
	                agentRole: "explorer",
	                dependencies: [],
	                targetAreas: ["src/App.tsx", "src/skillRouter.ts"],
	                acceptance: ["找到任务进入 runtime 前的路由位置"],
	                status: "draft"
	              },
	              {
	                id: "implement-board",
	                title: "实现任务板",
	                goal: "接入任务板预览、执行 prompt 和状态展示。",
	                agentRole: "worker",
	                dependencies: ["inspect-flow"],
	                targetAreas: ["src/App.tsx", "src/taskDecomposition.ts"],
	                acceptance: ["复杂任务先显示任务板"],
	                status: "draft"
	              },
	              {
	                id: "verify-board",
	                title: "验证任务板",
	                goal: "确认普通任务不被拦截，复杂任务可按任务板执行。",
	                agentRole: "tester",
	                dependencies: ["implement-board"],
	                targetAreas: ["test/taskDecomposition.test.cjs"],
	                acceptance: ["路由、解析和执行 prompt 测试通过"],
	                status: "draft"
	              }
	            ],
	            warnings: ["Browser preview uses synthetic task-board data."]
	          }, null, 2),
	          "```"
	        ].join("\n")
	        : `Preview runtime reply for: ${payload.prompt}`;
	      const assistantItem: RuntimeApiItemRecord = {
	        id: assistantItemId,
	        turn_id: turnId,
	        kind: "agent_message",
	        status: "completed",
	        summary: "Preview reply",
	        detail: previewAssistantDetail,
	        metadata: null,
	        artifact_refs: [],
	        started_at: now,
	        ended_at: now
	      };
	      detail.thread.latest_turn_id = turnId;
	      detail.thread.updated_at = now;
	      detail.turns = [...detail.turns.filter((candidate) => candidate.id !== turnId), turn];
	      detail.items = [...detail.items, userItem, assistantItem];
	      detail.latest_seq = ++previewThreadSeq;
	      previewThreadDetails.set(threadId, detail);
	      setTimeout(() => {
	        publishPreviewThreadEvent(threadId, {
	          seq: detail.latest_seq,
	          timestamp: now,
	          thread_id: threadId,
	          turn_id: turnId,
	          item_id: assistantItemId,
	          event: "turn.completed",
	          payload: {
	            turn,
	            item: assistantItem
	          }
	        }, detail);
	      }, 0);
	      return { ok: true, threadId, thread: detail.thread, turn, detail };
	    },
	    resumeRuntimeApiThread: async (payload) => {
	      const detail = ensurePreviewThread(payload.threadId);
	      return { ok: true, thread: detail.thread };
	    },
	    forkRuntimeApiThread: async (payload) => {
	      const source = ensurePreviewThread(payload.threadId);
	      const forked = JSON.parse(JSON.stringify(source)) as RuntimeApiThreadDetail;
	      forked.thread.id = `preview-thread-${Date.now().toString(36)}`;
	      forked.thread.created_at = new Date().toISOString();
	      forked.thread.updated_at = forked.thread.created_at;
	      previewThreadDetails.set(forked.thread.id, forked);
	      return { ok: true, thread: forked.thread };
	    },
	    archiveRuntimeApiThread: async (payload) => {
	      const detail = ensurePreviewThread(payload.threadId);
	      detail.thread.archived = payload.archived !== false;
	      detail.thread.updated_at = new Date().toISOString();
	      previewThreadDetails.set(detail.thread.id, detail);
	      return { ok: true, thread: detail.thread };
	    },
	    steerRuntimeApiTurn: async () => ({ ok: true }),
	    interruptRuntimeApiTurn: async () => ({ ok: true }),
	    answerRuntimeApiUserInput: async () => ({ ok: true }),
	    listRuntimeApiSkills: async (settings = previewSettings) => ({
	      ok: true,
	      directory: "/browser-preview/userData/skills",
	      warnings: [],
	      skills: previewRuntimeApiSkills({ ...previewSettings, ...settings })
	    }),
	    setRuntimeApiSkillEnabled: async (payload) => {
	      const name = payload.name;
	      previewSettings.enabledSkills = payload.enabled
	        ? Array.from(new Set([...previewSettings.enabledSkills, name]))
	        : previewSettings.enabledSkills.filter((id) => id !== name);
	      const skill = previewRuntimeApiSkills(previewSettings).find((candidate) => candidate.id === name || candidate.name === name);
	      publishPreviewRuntimeApiStatus(runtimeApiStatuses);
	      return { ok: true, skill };
	    },
	    listRuntimeApiMcpServers: async (settings = previewSettings) => ({
	      ok: true,
	      servers: previewRuntimeApiMcpServers({ ...previewSettings, ...settings })
	    }),
	    decideRuntimeApiApproval: async (payload) => {
	      previewRuntimeApiStatus.pendingApprovals = previewRuntimeApiStatus.pendingApprovals.filter((approval) => (
	        approval.id !== payload.approvalId && approval.approvalId !== payload.approvalId
	      ));
	      publishPreviewRuntimeApiStatus(runtimeApiStatuses);
	      return { ok: true, result: { decision: payload.decision } };
	    },
	    getGitStatus: async (workspacePath) => previewGitStatus(workspacePath),
    initGitRepository: async (workspacePath) => ({ ok: true, status: previewGitStatus(workspacePath), output: "Initialized empty Git repository" }),
    setGitRemote: async (payload) => ({ ok: true, status: { ...previewGitStatus(payload.workspacePath), originUrl: payload.remoteUrl }, output: "" }),
    switchGitBranch: async (payload) => {
      if (previewGitStatus(payload.workspacePath).hasChanges) {
        return {
          ok: false,
          error: "Commit or stash local changes before switching branches.",
          status: previewGitStatus(payload.workspacePath)
        };
      }
      previewGitBranch = payload.branchName || previewGitBranch;
      return { ok: true, status: previewGitStatus(payload.workspacePath), output: `Switched to ${previewGitBranch}` };
    },
    fetchGitRepository: async (payload) => ({ ok: true, status: previewGitStatus(payload.workspacePath), output: "Fetched origin" }),
    pullGitRepository: async (payload) => ({ ok: true, status: previewGitStatus(payload.workspacePath), output: "Already up to date." }),
    pushGitRepository: async (payload) => ({ ok: true, status: previewGitStatus(payload.workspacePath), output: "Pushed main" }),
    commitGitRepository: async (payload) => ({
      ok: Boolean(payload.message.trim()),
      error: payload.message.trim() ? undefined : "Commit message is required.",
      status: { ...previewGitStatus(payload.workspacePath), hasChanges: false, changes: [] },
      output: payload.message.trim() ? "[main abc1234] Preview commit" : ""
    }),
    getGitDiffSummary: async (payload) => ({
      ok: true,
      status: previewGitStatus(payload.workspacePath),
      output: [
        "Changed files:",
        " M src/App.tsx",
        "?? docs/git-notes.md",
        "",
        "Unstaged diff stat:",
        " src/App.tsx | 12 +++++++++---"
      ].join("\n")
    }),
	    startTerminal: async (options) => {
	      const runtime = previewRuntime(options);
	      const now = new Date().toISOString();
	      const event: RuntimeEvent = {
	        id: `preview-${Date.now().toString(36)}`,
	        type: "run-started",
	        label: "Run started",
	        detail: options.launchAction,
	        at: now
	      };
	      previewRuntimeSnapshot = {
	        ...previewRuntimeSnapshot,
	        status: "running",
	        source: "pty",
	        sessionId: `preview-${Date.now().toString(36)}`,
	        mode: options.launchAction,
	        workspacePath: options.workspacePath,
	        pid: 0,
	        command: "browser-preview://deepseek",
	        args: [options.launchAction, options.agentPrompt || ""].filter(Boolean),
	        startedAt: now,
	        updatedAt: now,
	        events: [...previewRuntimeSnapshot.events, event].slice(-80)
	      };
	      runtimeEvents.forEach((listener) => listener(event));
	      runtimeSnapshots.forEach((listener) => listener(previewRuntimeSnapshot));
	      const line = [
	        "\r\nbrowser-preview://deepseek ",
        options.launchAction === "exec" || options.launchAction === "plan" ? `${options.launchAction} exec --auto` : options.launchAction,
        "\r\n",
        "Electron preload is not active in browser preview.\r\n\r\n"
      ].join("");
      listeners.forEach((listener) => listener(line));
      return { ok: true, runtime, pid: 0 };
    },
	    stopTerminal: async () => {
	      const now = new Date().toISOString();
	      const event: RuntimeEvent = {
	        id: `preview-${Date.now().toString(36)}`,
	        type: "run-exit",
	        label: "Run completed",
	        detail: "exitCode=0",
	        at: now
	      };
	      previewRuntimeSnapshot = {
	        ...previewRuntimeSnapshot,
	        status: "completed",
	        updatedAt: now,
	        lastExit: { exitCode: 0, exitedAt: now },
	        events: [...previewRuntimeSnapshot.events, event].slice(-80)
	      };
	      runtimeEvents.forEach((listener) => listener(event));
	      runtimeSnapshots.forEach((listener) => listener(previewRuntimeSnapshot));
	      exits.forEach((listener) => listener({ exitCode: 0 }));
	      return { ok: true };
    },
    sendTerminalInput: () => undefined,
    resizeTerminal: () => undefined,
    getRemoteStatus: async () => previewRemoteStatus(),
    restartRemoteBridge: async () => previewRemoteStatus(),
    rotateRemoteToken: async () => {
      previewSettings.mobileBridgeToken = `preview-${Date.now().toString(36)}`;
      return { settings: { ...previewSettings }, status: previewRemoteStatus() };
    },
    loginRemoteAccount: async (payload) => {
      const accountId = (payload.accountId || payload.email || "preview@example.com").toLowerCase();
      previewAuth = {
        ...previewAuth,
        loggedIn: true,
        account: {
          accountId,
          email: payload.email || accountId,
          displayName: payload.displayName || payload.name || accountId,
          loggedInAt: new Date().toISOString()
        },
        pairing: null
      };
      const status = previewRemoteStatus();
      remoteStatuses.forEach((listener) => listener(status));
      return { ok: true, auth: previewAuth, status };
    },
    logoutRemoteAccount: async () => {
      previewAuth = { ...previewAuth, loggedIn: false, account: null, pairing: null, devices: [] };
      const status = previewRemoteStatus();
      remoteStatuses.forEach((listener) => listener(status));
      return { ok: true, auth: previewAuth, status };
    },
    startRemotePairing: async () => {
      const pairing = {
        active: true,
        codePreview: "123 456",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString()
      };
      previewAuth = { ...previewAuth, pairing };
      const status = previewRemoteStatus();
      remoteStatuses.forEach((listener) => listener(status));
      return {
        ok: true,
        auth: previewAuth,
        status,
        pairing: {
          code: "123456",
          codePreview: pairing.codePreview,
          expiresAt: pairing.expiresAt,
          accountId: previewAuth.account?.accountId || "preview@example.com",
          desktopId: previewAuth.desktopId
        }
      };
    },
    revokeRemoteDevice: async (deviceId) => {
      previewAuth = { ...previewAuth, devices: previewAuth.devices.filter((device) => device.id !== deviceId) };
      const status = previewRemoteStatus();
      remoteStatuses.forEach((listener) => listener(status));
      return { ok: true, auth: previewAuth, status };
    },
    pushUpdateNotice: async (payload) => ({
      ok: previewSettings.updatePushEnabled,
      notice: previewSettings.updatePushEnabled ? {
        id: "preview-update",
        source: "browser-preview",
        accountId: payload.accountId || previewAuth.account?.accountId || "",
        matchedDeviceIds: previewAuth.devices.map((device) => device.id),
        version: payload.version || "0.1.1",
        title: payload.title || "Preview update",
        body: payload.body || payload.message || "Preview update notice",
        url: payload.url || payload.downloadUrl || "",
        createdAt: new Date().toISOString()
      } : undefined,
      error: previewSettings.updatePushEnabled ? undefined : "Update push notifications are disabled"
    }),
    onTerminalData: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
	    onTerminalExit: (callback) => {
	      exits.add(callback);
	      return () => exits.delete(callback);
	    },
	    onRuntimeSnapshot: (callback) => {
	      runtimeSnapshots.add(callback);
	      return () => runtimeSnapshots.delete(callback);
	    },
	    onRuntimeEvent: (callback) => {
	      runtimeEvents.add(callback);
	      return () => runtimeEvents.delete(callback);
	    },
	    onRuntimeOrchestratorSnapshot: (callback) => {
	      runtimeOrchestratorSnapshots.add(callback);
	      return () => runtimeOrchestratorSnapshots.delete(callback);
	    },
	    onRuntimeTurnEvent: (callback) => {
	      runtimeTurnEvents.add(callback);
	      return () => runtimeTurnEvents.delete(callback);
	    },
	    onRuntimeApiStatus: (callback) => {
	      runtimeApiStatuses.add(callback);
	      return () => runtimeApiStatuses.delete(callback);
	    },
	    onRuntimeApiThreadEvent: (callback) => {
	      runtimeApiThreadEvents.add(callback);
	      return () => runtimeApiThreadEvents.delete(callback);
	    },
	    onRemoteStatus: (callback) => {
      remoteStatuses.add(callback);
      return () => remoteStatuses.delete(callback);
    },
    onDesktopUpdateAvailable: (callback) => {
      desktopUpdateListeners.add(callback);
      return () => desktopUpdateListeners.delete(callback);
    }
  };
}

export function getDesktopBridge(): Window["deepseekDesktop"] {
  return window.deepseekDesktop || createPreviewBridge();
}
