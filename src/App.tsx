import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  Activity,
  Bell,
  Brain,
  Bot,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Code2,
  Copy,
  Database,
  DownloadCloud,
  Droplets,
  FileCog,
  Fish,
  FolderOpen,
  Github,
  GitBranch,
  GitCommitHorizontal,
  Globe2,
  HardDrive,
  KeyRound,
  Layers3,
  Link2,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Square,
  TerminalSquare,
  Trash2,
  UploadCloud,
  UserRound,
  Waves,
  X,
  Zap
} from "lucide-react";
import { getDesktopBridge } from "./desktopApi";
import { shouldSubmitComposerShortcut } from "./composerKeys";
import {
  buildAnchoredRuntimePrompt,
  deriveContextAnchorTextsFromRuntimeItems,
  mergeDerivedContextAnchors,
  normalizeContextAnchors,
  selectContextAnchorDraft
} from "./contextAnchors";
import { formatProcessStreamOutput, normalizeDeepSeekThinkingMode, runtimeTurnOutputChunk } from "./processStream";
import { appendDesktopHookEvent, type DesktopHookEvent } from "./desktopHooks";
import { routeModelForPrompt, type ModelRouteDecision } from "./modelRouter";
import {
  appendRuntimePromptMessages,
  buildRecallArchivePrompt,
  conversationMessagesFromRuntimeDetail,
  orderedRuntimeConversationItems,
  summarizeRuntimeContextHealth,
  shouldRenderRuntimeConversation
} from "./runtimeConversation";
import { deriveInteractionState, type DeriveInteractionStateOptions, type InteractionPhase, type InteractionState } from "./interactionState";
import { buildRuntimeTimeline, type RuntimeTimeline, type RuntimeTimelineEntry } from "./runtimeTimeline";
import { routeSkillsForPrompt, type SkillRouteDecision } from "./skillRouter";
import { buildCapabilityContext, buildCapabilityRecords } from "./capabilityRegistry";
import {
  applyRuntimeStatusToTaskBoard,
  buildTaskDecompositionPrompt,
  parseTaskBoardPlan,
  shouldCreateTaskBoard
} from "./taskDecomposition";
import {
  applyTaskBoardRuntimeDetails,
  applyTaskRuntimeDetail,
  bindTaskBoardItemRuntime,
  buildTaskBoardItemExecutionPrompt,
  createTaskBoardRunId,
  nextRunnableTaskBoardItem,
  normalizeTaskBoardPlans as normalizeRegistryTaskBoardPlans,
  propagateBlockedTaskItems,
  queueTaskBoardItem,
  resetTaskBoardItemForRetry,
  taskBoardRunSummary
} from "./taskRegistry";

type InspectorPanel = "skills" | "remote" | "git" | "settings" | null;
type MainView = "chat" | "tools" | "tasks";
type ToolPage = "overview" | "skills" | "mcp";
type PermissionMode = "plan" | "agent" | "yolo";
type DeepSeekEndpointMode = "stable" | "beta" | "custom";
type StatusState =
  | { type: "ready" }
  | { type: "launching" }
  | { type: "running"; pid?: number }
  | { type: "stopped" }
  | { type: "settingsSaved" }
  | { type: "languageSaved" }
  | { type: "editorOpened"; editor: string }
  | { type: "exited"; exitCode?: number }
  | { type: "error"; message: string };

interface RunCapture {
  action: LaunchAction;
  prompt: string;
  sessionId: string;
  replyMessageId?: string;
  workspacePath: string;
  startedAt: string;
  output: string;
}

interface AutomationDraft {
  id?: string;
  name: string;
  prompt: string;
  workspacePath: string;
  minute: number;
  hour: number;
  timezone: string;
  status: AutomationStatus;
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  title?: string;
  content: string;
}

interface SkillPreset {
  id: string;
  name: string;
  description: string;
  icon: "zap" | "palette" | "calendar" | "download";
  category: string;
  tools: string[];
}

interface SkillCatalogItem extends SkillPreset {
  path: string;
  source: "default" | "file";
  origin: "preset" | "custom";
  content: string;
}

interface McpPreset {
  id: string;
  name: string;
  description: string;
  command: string;
  envHint: string;
  accent: "blue" | "orange" | "green" | "purple" | "red";
  category: "Coding" | "Browser" | "Data" | "Knowledge" | "Productivity" | "Remote";
  source: string;
  downloads: number;
  auth: "None" | "Token" | "Connection" | "OAuth";
  safety: "Low" | "Medium" | "High";
}

interface McpAdapterRow {
  id: string;
  name: string;
  description: string;
  envKey: string;
  envKeys: string[];
  guideUrl: string;
  guideLabel: string;
  guideActionLabel: string;
  auth: McpPreset["auth"];
  status: McpAdapterStatus | "untested";
  statusText: string;
  hint: string;
  injectable: boolean;
  warnings: string[];
  command: string;
}

interface McpSecretTarget {
  presetId: string;
  key: string;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_BETA_BASE_URL = "https://api.deepseek.com/beta";
const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
const SCHEDULED_TASK_SKILL_ID = "scheduled-task-agent";
const DEEPSEEK_V4_RELEASE_DOC_URL = "https://api-docs.deepseek.com/news/news260424";
const DEEPSEEK_MODEL_PRICING_DOC_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
const ACTIVE_RUNTIME_TURN_STATUSES = new Set<RuntimeTurnStatus>(["queued", "running", "cancelling"]);
const ACTIVE_RUNTIME_API_TURN_STATUSES = new Set<RuntimeApiTurnStatus>(["queued", "in_progress", "waiting_user_input"]);
const SUBMIT_BLOCKING_INTERACTION_PHASES = new Set<InteractionPhase>([
  "blocked",
  "routing",
  "queued",
  "running",
  "streaming",
  "waiting_user_input",
  "waiting_approval",
  "stale_running"
]);

interface DeepSeekModelPreset {
  value: string;
  label: string;
  apiModel: string;
  docsUrl: string;
  docsLabelZh: string;
  docsLabelEn: string;
}

const defaultSettings: DesktopSettings = {
  language: "zh",
  workspacePath: "",
  binaryMode: "bundled",
  customBinaryPath: "",
  provider: "deepseek",
  model: DEFAULT_DEEPSEEK_MODEL,
  baseUrl: DEEPSEEK_BASE_URL,
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
  enabledSkills: ["superpowers", "ui-ux-pro-max", SCHEDULED_TASK_SKILL_ID, "cron-scheduler", "skill-downloader"],
  enabledMcpServers: [],
  mobileBridgeEnabled: false,
  mobileBridgeHost: "127.0.0.1",
  mobileBridgePort: 8765,
  mobileBridgeToken: "",
  mobileRemoteControlEnabled: false,
  updatePushEnabled: false
};

const skillPresets: SkillPreset[] = [
  {
    id: "superpowers",
    name: "Superpowers",
    description: "加强规划、分解任务、代码修改和自检的默认工作流。",
    icon: "zap",
    category: "Agent",
    tools: ["Plan", "Patch", "Verify"]
  },
  {
    id: "ui-ux-pro-max",
    name: "UI/UX Pro Max",
    description: "导入完整 UI/UX Pro Max 设计智能库，包含样式、配色、字体、图表、UX 和多技术栈检索。",
    icon: "palette",
    category: "Design",
    tools: ["Search", "Design System", "Visual QA"]
  },
  {
    id: SCHEDULED_TASK_SKILL_ID,
    name: "定时任务 Agent",
    description: "把普通定时任务请求交给 Agent 的 Skill：先补齐任务、时间、工作区，再生成 cron、launchd 或一次性脚本方案。",
    icon: "calendar",
    category: "定时任务",
    tools: ["Schedule", "Cron", "launchd"]
  },
  {
    id: "cron-scheduler",
    name: "Cron 高级脚本",
    description: "仅用于需要手写 crontab 文件的高级场景；普通定时任务由定时任务 Agent Skill 处理。",
    icon: "calendar",
    category: "定时任务",
    tools: ["Advanced", "Cron", "Logs"]
  },
  {
    id: "skill-downloader",
    name: "Skill 下载",
    description: "让 Agent 通过 curl 真实下载 Skill，保存并验证 SKILL.md，而不是手写相似内容。",
    icon: "download",
    category: "Skills",
    tools: ["Download", "Install", "Verify"]
  }
];

const mcpPresets: McpPreset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "将当前 workspace 作为 MCP 文件上下文暴露给 Agent。",
    command: "npx -y @modelcontextprotocol/server-filesystem <workspace>",
    envHint: "Workspace path",
    accent: "green",
    category: "Coding",
    source: "@modelcontextprotocol/server-filesystem",
    downloads: 357283,
    auth: "None",
    safety: "High"
  },
  {
    id: "github",
    name: "GitHub",
    description: "连接仓库、Issue、PR 和代码搜索。需要 GitHub token。",
    command: "npx -y @modelcontextprotocol/server-github",
    envHint: "GITHUB_PERSONAL_ACCESS_TOKEN",
    accent: "blue",
    category: "Coding",
    source: "@modelcontextprotocol/server-github",
    downloads: 109525,
    auth: "Token",
    safety: "High"
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "浏览器自动化、页面检查和端到端测试，Cursor/Claude 开发流里最常见的浏览器 MCP。",
    command: "npx -y @playwright/mcp",
    envHint: "无需 token",
    accent: "green",
    category: "Browser",
    source: "@playwright/mcp",
    downloads: 2143014,
    auth: "None",
    safety: "Medium"
  },
  {
    id: "context7",
    name: "Context7",
    description: "给 Agent 提供最新框架/库文档上下文，适合编码时查官方 API。",
    command: "npx -y @upstash/context7-mcp",
    envHint: "无需 token",
    accent: "purple",
    category: "Knowledge",
    source: "@upstash/context7-mcp",
    downloads: 1542305,
    auth: "None",
    safety: "Low"
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "只读/查询 PostgreSQL 数据库结构和数据，适合全栈项目排查。",
    command: "npx -y @modelcontextprotocol/server-postgres <connection-string>",
    envHint: "POSTGRES_CONNECTION_STRING",
    accent: "blue",
    category: "Data",
    source: "@modelcontextprotocol/server-postgres",
    downloads: 96218,
    auth: "Connection",
    safety: "High"
  },
  {
    id: "mcp-remote",
    name: "MCP Remote",
    description: "把本地-only 客户端接到远程 MCP，适合 OAuth/托管 MCP 桥接。",
    command: "npx -y mcp-remote <remote-url>",
    envHint: "MCP_REMOTE_URL",
    accent: "purple",
    category: "Remote",
    source: "mcp-remote",
    downloads: 313116,
    auth: "OAuth",
    safety: "Medium"
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "分步骤推理/规划工具，适合复杂调试和方案拆解。",
    command: "npx -y @modelcontextprotocol/server-sequential-thinking",
    envHint: "无需 token",
    accent: "purple",
    category: "Knowledge",
    source: "@modelcontextprotocol/server-sequential-thinking",
    downloads: 90477,
    auth: "None",
    safety: "Low"
  },
  {
    id: "memory",
    name: "Memory",
    description: "知识图谱式长期记忆，适合跨会话保存项目事实。",
    command: "npx -y @modelcontextprotocol/server-memory",
    envHint: "本地存储",
    accent: "purple",
    category: "Knowledge",
    source: "@modelcontextprotocol/server-memory",
    downloads: 65339,
    auth: "None",
    safety: "Medium"
  },
  {
    id: "slack",
    name: "Slack",
    description: "读取/发送 Slack 工作区信息，适合团队协作场景。",
    command: "npx -y @modelcontextprotocol/server-slack",
    envHint: "SLACK_BOT_TOKEN, SLACK_TEAM_ID",
    accent: "purple",
    category: "Productivity",
    source: "@modelcontextprotocol/server-slack",
    downloads: 56071,
    auth: "Token",
    safety: "High"
  },
  {
    id: "notion",
    name: "Notion",
    description: "官方 Notion MCP，可读取和管理 Notion 页面/数据库。",
    command: "npx -y @notionhq/notion-mcp-server",
    envHint: "NOTION_TOKEN",
    accent: "red",
    category: "Productivity",
    source: "@notionhq/notion-mcp-server",
    downloads: 52740,
    auth: "Token",
    safety: "High"
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "官方 Sentry MCP，用于读取错误、项目和事件上下文。",
    command: "npx -y @sentry/mcp-server",
    envHint: "SENTRY_ACCESS_TOKEN",
    accent: "purple",
    category: "Coding",
    source: "@sentry/mcp-server",
    downloads: 50170,
    auth: "Token",
    safety: "Medium"
  },
  {
    id: "figma",
    name: "Figma Developer",
    description: "让 Agent 读取 Figma 设计数据，辅助实现 UI。",
    command: "npx -y figma-developer-mcp",
    envHint: "FIGMA_API_KEY",
    accent: "red",
    category: "Productivity",
    source: "figma-developer-mcp",
    downloads: 40225,
    auth: "Token",
    safety: "Medium"
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "官方 Stripe MCP，适合支付、订阅、发票和客户数据操作。",
    command: "npx -y @stripe/mcp",
    envHint: "STRIPE_SECRET_KEY",
    accent: "blue",
    category: "Data",
    source: "@stripe/mcp",
    downloads: 37775,
    auth: "Token",
    safety: "High"
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "传统浏览器自动化 MCP，适合截图、抓取和表单流程。",
    command: "npx -y @modelcontextprotocol/server-puppeteer",
    envHint: "无需 token",
    accent: "green",
    category: "Browser",
    source: "@modelcontextprotocol/server-puppeteer",
    downloads: 28205,
    auth: "None",
    safety: "Medium"
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web 搜索 MCP，适合需要外部搜索但不想接浏览器时使用。",
    command: "npx -y @modelcontextprotocol/server-brave-search",
    envHint: "BRAVE_API_KEY",
    accent: "orange",
    category: "Knowledge",
    source: "@modelcontextprotocol/server-brave-search",
    downloads: 24872,
    auth: "Token",
    safety: "Low"
  },
  {
    id: "google-maps",
    name: "Google Maps",
    description: "地理位置、路线和地点查询 MCP。",
    command: "npx -y @modelcontextprotocol/server-google-maps",
    envHint: "GOOGLE_MAPS_API_KEY",
    accent: "green",
    category: "Data",
    source: "@modelcontextprotocol/server-google-maps",
    downloads: 9335,
    auth: "Token",
    safety: "Medium"
  },
  {
    id: "pannel",
    name: "Panel / 1Panel",
    description: "1Panel 服务器面板管理 MCP，适合网站、数据库、应用和面板状态读取。",
    command: "mcp-1panel",
    envHint: "PANEL_HOST, PANEL_ACCESS_TOKEN",
    accent: "orange",
    category: "Remote",
    source: "github.com/1Panel-dev/mcp-1panel",
    downloads: 0,
    auth: "Token",
    safety: "High"
  }
];

const modelPresets: DeepSeekModelPreset[] = [
  {
    value: "deepseek-v4-pro",
    label: "DeepSeek v4 Pro",
    apiModel: "deepseek-v4-pro",
    docsUrl: `${DEEPSEEK_V4_RELEASE_DOC_URL}#deepseek-v4-pro`,
    docsLabelZh: "DeepSeek v4 Pro 官方文档",
    docsLabelEn: "DeepSeek v4 Pro docs"
  },
  {
    value: "deepseek-v4-pro-1m",
    label: "DeepSeek v4 Pro 1M",
    apiModel: "deepseek-v4-pro",
    docsUrl: `${DEEPSEEK_MODEL_PRICING_DOC_URL}#model-details`,
    docsLabelZh: "DeepSeek v4 Pro 1M 官方文档",
    docsLabelEn: "DeepSeek v4 Pro 1M docs"
  },
  {
    value: "deepseek-v4-flash",
    label: "DeepSeek v4 Flash",
    apiModel: "deepseek-v4-flash",
    docsUrl: `${DEEPSEEK_V4_RELEASE_DOC_URL}#deepseek-v4-flash`,
    docsLabelZh: "DeepSeek v4 Flash 官方文档",
    docsLabelEn: "DeepSeek v4 Flash docs"
  },
  {
    value: "deepseek-v4-flash-1m",
    label: "DeepSeek v4 Flash 1M",
    apiModel: "deepseek-v4-flash",
    docsUrl: `${DEEPSEEK_MODEL_PRICING_DOC_URL}#model-details`,
    docsLabelZh: "DeepSeek v4 Flash 1M 官方文档",
    docsLabelEn: "DeepSeek v4 Flash 1M docs"
  }
];

const primaryModelPresets = modelPresets.filter((preset) => (
  preset.value === "deepseek-v4-pro" || preset.value === "deepseek-v4-flash"
));

function findModelPreset(model: string) {
  return modelPresets.find((preset) => preset.value === model);
}

function normalizeDeepSeekModelSelection(model: string) {
  const value = String(model || "").trim();
  if (findModelPreset(value)) {
    return value;
  }
  if (value === "deepseek-chat" || value === "deepseek-reasoner") {
    return "deepseek-v4-flash";
  }
  return DEFAULT_DEEPSEEK_MODEL;
}

function modelPresetForValue(model: string) {
  return findModelPreset(normalizeDeepSeekModelSelection(model)) || modelPresets[0];
}

function apiModelForProvider(provider: ProviderMode, model: string) {
  if (provider === "nvidia-nim") {
    return model || DEFAULT_DEEPSEEK_MODEL;
  }
  return modelPresetForValue(model).apiModel;
}

const uiCopy = {
  zh: {
    status: {
      ready: "就绪",
      checking: "检查中",
      missing: "缺失",
      runtimeReady: "就绪",
      launching: "正在启动",
      runningPid: (pid?: number) => pid ? `运行中 pid ${pid}` : "运行中",
      launchFailed: "启动失败",
      stopped: "已停止",
      settingsSaved: "设置已保存",
      languageSaved: "语言已切换",
      editorOpened: (editor: string) => `已打开 ${editor}`,
      exited: (exitCode?: number) => `已退出 ${exitCode ?? ""}`.trim()
    },
    welcome: {
      title: "DeepSeek TUI Desktop",
      content: "选择项目目录后可以直接开始对话。模型和运行模式可以在主界面切换。"
    },
    newConversation: {
      title: "新对话",
      content: "选择 workspace 后输入任务即可开始。"
    },
    promptResult: {
      planTitle: "Plan",
      harnessTitle: "Agent",
      yoloTitle: "YOLO",
      planContent: "DeepSeek TUI 已进入 Plan 模式，正在分析目标并生成不会改动文件的执行计划。",
      execContent: "DeepSeek TUI Agent 正在读取 workspace、调用工具并处理这条任务；完成后会把主要回复写在这里。",
      yoloContent: "DeepSeek TUI YOLO 模式已接管任务，正在按高权限执行；完成后会把主要回复写在这里。"
    },
    runSummary: {
      title: "DeepSeek TUI 回复",
      status: "状态",
      mode: "模式",
      workspace: "Workspace",
      started: "开始时间",
      terminal: "过程摘要",
      success: "完成",
      failed: "失败",
      noOutput: "已完成。",
      failedShort: "未完成，请查看运行摘要。",
      completedShort: "已完成。"
    },
    sidebar: {
      subtitle: "Desktop",
      newChat: "新对话",
      navLabel: "对话列表",
      assistant: "DeepSeek 编程助手",
      running: "运行中",
      automations: "定时任务 Skill",
      remote: "手机控制",
      git: "GitHub 版本",
      settings: "设置"
    },
    history: {
      noProject: "未选择项目",
      untitled: "新会话",
      empty: "暂无历史会话",
      deleteSession: "删除会话",
      selectProject: "选中项目",
      newProjectSession: "在此项目中新建对话",
      sessions: (count: number) => `${count} 个会话`
    },
    topbar: {
      title: "DeepSeek 编程对话",
      noWorkspace: "未选择 workspace",
      viewSwitch: "界面视图切换",
	      chat: "对话",
	      tools: "工具",
      checkRuntime: "检查运行环境",
      chooseWorkspace: "选择 workspace",
      currentBranch: "当前分支",
      noBranch: "未检测到分支",
      updateAvailable: (version: string) => `新版本 ${version}`,
      openCursor: "打开 Cursor",
      apiKeySaved: "API Key 已保存",
      apiKeyMissing: "设置 API Key",
      remoteStopped: "手机控制未启动"
    },
    tools: {
      enabledMcp: "已选择 MCP",
      enabledSkills: "已启用 Skills",
      enabledAutomations: "运行中定时任务",
      installablePresets: "可安装预设",
      automationsDesc: "只保留每天几点运行、任务内容、工作区和启用状态。",
      manageAutomations: "管理定时任务",
      mcpStatus: "MCP 工具状态",
      mcpStatusDesc: "MCP 是给 Agent 接入浏览器、GitHub、数据库等外部工具的配置。需要 token 或 URL 的工具可在本机加密/本地配置后再启动。",
      manageMcp: "管理 MCP",
      off: "关闭",
      enabled: "已启用",
      selected: "已选择",
      skillsDesc: "Skills 是可新增、导入和勾选的 Markdown 指令，告诉 Agent 遇到某类任务时该怎么做。",
      manageSkills: "管理 Skills"
	    },
	    runtimeApi: {
	      title: "AppService",
	      subtitle: "上游 Runtime HTTP API 已渐进接入；主对话仍使用现有 CLI runner。",
	      connected: "已连接",
	      starting: "启动中",
	      idle: "未启动",
	      stopped: "已停止",
	      error: "异常",
	      refresh: "刷新",
	      runtimeInfo: "Runtime 信息",
	      skills: "Skills 状态",
	      mcp: "MCP Servers",
	      approvals: "审批事件",
	      noSkills: "Runtime API 暂未返回 Skill。",
	      noMcp: "Runtime API 暂未返回 MCP server。",
	      noApprovals: "暂无待处理审批。",
	      authRequired: "Bearer token 已启用",
	      authOff: "未启用鉴权",
	      unavailable: "Runtime API 不可用，主聊天 CLI runner 不受影响。",
	      toggleFailed: "Skill 状态更新失败"
	    },
	    runtimeContext: {
	      title: "上下文保留",
	      enabled: "分层上下文已开启",
	      disabled: "分层上下文已关闭",
	      recentTurns: (count: number) => `最近 ${count} 轮逐字保留`,
	      seams: (count: number) => `${count} 个 seam`,
	      compactions: (count: number) => `${count} 次 compaction`,
	      approvals: (count: number) => `${count} 个审批待处理`,
	      questions: (count: number) => `${count} 个追问待处理`,
	      waiting: "等待用户输入",
	      running: "正在执行",
	      completed: "本轮完成",
	      recall: "回拉旧上下文",
	      recallHint: "当长任务已经跨周期或做过 compaction 时，可以用它把旧归档重新拉回当前任务。",
	      pin: "固定当前锚点",
	      noAnchors: "还没有固定锚点。建议把不会变的关键约束固定下来。"
	    },
	    terminal: {
	      streamTitle: "流式输出",
	      clear: "清空输出",
	      stop: "停止",
	      bootReady: "终端已就绪。\r\n",
	      bootHint: "运行输出会显示在这里。\r\n\r\n"
	    },
	    runtimeAgents: {
	      title: "Agent 运行状态",
	      subtitle: "结构化状态来自 runtime API；不可用时由终端事件兜底生成。",
	      status: "状态",
	      source: "来源",
	      mode: "模式",
	      workspace: "Workspace",
	      started: "开始",
		      noAgents: "还没有检测到 Agent。",
          trackedCount: (count: number) => `已检测到 ${count} 个 Agent`,
          runningCount: (count: number) => `当前 ${count} 个 Agent 正在运行`,
	      recentEvents: "最近事件",
	      noEvents: "暂无运行事件。",
	      counts: (running: number, completed: number, failed: number) => `${running} 运行 / ${completed} 完成 / ${failed} 失败`,
	      statuses: {
	        idle: "空闲",
	        running: "运行中",
	        completed: "已完成",
	        failed: "失败",
	        stopped: "已停止",
	        queued: "排队中",
	        cancelling: "取消中",
	        cancelled: "已取消"
	      }
	    },
	    composer: {
      modeLabel: "运行模式",
      modelLabel: "模型",
      stop: "停止",
      planPlaceholder: "描述目标，Plan 模式只会输出计划，不改文件...",
      execPlaceholder: "给 Agent 模式一个编程任务...",
      yoloPlaceholder: "给 YOLO 模式一个高权限任务..."
    },
    inspector: {
      titles: {
        skills: "Skills",
        mcp: "MCP 预设",
        automations: "定时任务",
        remote: "手机控制",
        git: "GitHub 版本",
        settings: "设置"
      },
      subtitles: {
        skills: "新增、导入并勾选启动时加载的 Skill",
        mcp: "勾选预设，也可以新增自定义 MCP",
        automations: "以 Skill 方式引导 Agent 生成本机计划任务",
        remote: "手机查看进度、远程控制和更新提醒",
        git: "查看分支、远程仓库、变更、提交和推送",
        settings: "Workspace、运行环境和 Agent 参数"
      },
      close: "关闭"
    },
    skills: {
      customDirPlaceholder: "可选：自定义 skills 目录",
      chooseDir: "选择 skills 目录",
      save: "保存 Skills",
      enableRuntime: "启动时注入 Skills",
      runtimeHint: "关闭后仍可新增和导入 Skill，但启动运行时不会加载这些 Skill。",
      createTitle: "新增 Skill",
      createName: "名称",
      createNamePlaceholder: "例如：日报检查",
      createDescription: "触发条件",
      createDescriptionPlaceholder: "Use when...",
      createSkill: "新增 Skill",
      importSkill: "导入 Skills",
      importFailed: "导入失败",
      created: (path: string) => `Skill 已新增：${path}`,
      imported: (count: number) => `已导入 ${count} 个 Skill`,
      saveFailed: "Skill 保存失败",
      scheduledOpened: "定时任务现在作为默认 Skill 注入给 Agent；启用后，对话里提出定时、提醒、每天/每小时运行等请求会触发这个 Skill。",
      customCategory: "自定义",
      defaultTag: "默认",
      fileTag: "文件"
    },
    mcp: {
      helpTitle: "MCP 是什么",
      helpBody: "MCP 可以理解为 Agent 的工具插座。这里默认只是选择预设和新增自定义 MCP；只有打开“启动时启用 MCP 接口”后，启动运行时才会注入这些 MCP。",
      searchPlaceholder: "搜索 MCP、命令、分类...",
      summaryEnabled: (count: number) => `${count} 已选择`,
      summaryVisible: (count: number) => `${count} 可见`,
      summaryInstalled: (count: number) => `${count} 个内置预设`,
      customConfigPlaceholder: "可选：使用已有 MCP JSON 文件",
      chooseConfig: "选择 MCP 配置",
      save: "保存 MCP",
      enableRuntime: "启动时启用 MCP 接口",
      runtimeHint: "默认关闭。关闭时可以选择、新增和预检，但不会设置 DEEPSEEK_MCP_CONFIG，也不会启动 MCP 服务。",
      runtimeOn: "启动时会注入 MCP",
      runtimePending: "MCP 接口已打开，但还没有可注入的配置",
      runtimeOff: "启动时不会注入 MCP",
      runtimeBlocked: "已选择 MCP，但未完成配置，启动时不会注入这些 MCP。",
      riskSuffix: "风险",
      sourceCustom: "来自自定义 JSON",
      configFailed: "MCP JSON 保存失败",
      test: "预检 MCP",
      testing: "正在预检 MCP...",
      testOk: "MCP 预检通过",
      testFailed: "MCP 预检发现问题",
      adapterTitle: "MCP 适配状态",
      adapterDesc: "只有显示为可启动的 MCP 才会写入运行时配置；缺 token、缺 URL 或命令不可用时，页面只保留选择状态，不显示为已启动。",
      setupTitle: "服务配置向导",
      setupDesc: "打开 MCP 页面后先搜索服务；选择后直接填写 token、OAuth URL、登录信息或连接串。保存后会自动选择并启用该 MCP。",
      setupEmptyTitle: "没有匹配的 MCP",
      setupEmptyBody: "换一个关键词，或在下面新增自定义 MCP。",
      selectFirst: "选择 GitHub 并配置",
      chooseService: "选择并配置",
      selected: "已选择",
      notSelected: "未选择",
      selectedNoAuth: (name: string) => `${name} 已选择并启用，无需额外凭证。`,
      secretSavedAndEnabled: (key: string) => `${key} 已保存，MCP 已选择并启用`,
      noMatches: "没有搜索结果",
      openGuide: "打开配置页面",
      noAuthRequired: "无需凭证",
      configureEnvKey: (key: string) => `配置 ${key}`,
      getToken: "获取 token",
      oauthLogin: "OAuth / 登录",
      connectionSetup: "打开连接配置",
      viewDocs: "查看配置指南",
      ready: "可启动",
      needsAuth: "缺认证",
      needsConfig: "缺配置",
      commandMissing: "命令缺失",
      invalidUrl: "URL 无效",
      untested: "待预检",
      injectable: "会启动",
      notInjected: "不会启动",
      configureSecret: "配置",
      secretPlaceholder: "粘贴 token / URL / 连接串",
      saveSecret: "保存配置",
      secretSaved: (key: string) => `${key} 已保存`,
      secretFailed: "配置保存失败",
      guide: "配置指南",
      noServers: "当前没有选择 MCP 服务器，也没有自定义 MCP JSON。",
      customTitle: "新增 MCP",
      customHint: "填写一个 command 型或 URL 型 MCP，新增后会直接保存为自定义 MCP 配置。",
      customId: "服务器 ID",
      customIdPlaceholder: "例如：my-server",
      customCommand: "Command",
      customCommandPlaceholder: "npx / node / uvx / python",
      customArgs: "Args",
      customArgsPlaceholder: "-y\n@modelcontextprotocol/server-memory",
      customUrl: "URL",
      customUrlPlaceholder: "https://example.com/mcp",
      customEnv: "Env JSON",
      customEnvPlaceholder: "{\"TOKEN\":\"\"}",
      addCustom: "新增 MCP",
      customAdded: (id: string) => `已新增 MCP：${id}`,
      customInvalidId: "服务器 ID 只能包含字母、数字、点、下划线和横线。",
      customMissingTarget: "请填写 Command 或 URL。",
      customInvalidJson: "MCP JSON 或 Env JSON 格式不正确。"
    },
    git: {
      repoReady: "Git 仓库已连接",
      notRepoTitle: "当前 workspace 还不是 Git 仓库",
      notRepoBody: "初始化后才能绑定 GitHub remote、提交和推送。",
      repoRoot: "仓库根目录",
      branch: "分支",
      upstream: "上游",
      remote: "GitHub remote",
      noRemote: "未设置 origin",
      remotePlaceholder: "https://github.com/owner/repo.git 或 git@github.com:owner/repo.git",
      init: "初始化 Git",
      saveRemote: "保存 remote",
      copyRemote: "复制 remote",
      switchBranch: "切换分支",
      switchBranchOk: "分支已切换",
      dirtyBranchBlocked: "切换分支前请先提交或暂存当前工作区改动。",
      localBranch: "本地",
      remoteBranch: "远程",
      refresh: "刷新",
      fetch: "Fetch",
      pull: "Pull",
      push: "Push",
      changes: "变更",
      noChanges: "工作区干净",
      staged: "已暂存",
      unstaged: "未暂存",
      untracked: "未跟踪",
      commitMessage: "提交信息",
      commitPlaceholder: "描述这次修改",
      commit: "Stage all + Commit",
      preview: "预览提交范围",
      previewTitle: "提交前预览",
      previewOk: "已生成提交前预览",
      lastCommit: "最近提交",
      noCommit: "暂无提交",
      aheadBehind: (ahead: number, behind: number) => `ahead ${ahead} / behind ${behind}`,
      initOk: "Git 仓库已初始化",
      remoteOk: "GitHub remote 已保存",
      fetchOk: "Fetch 完成",
      pullOk: "Pull 完成",
      pushOk: "Push 完成",
      commitOk: "Commit 已创建",
      copied: "Remote 已复制",
      actionFailed: "Git 操作失败"
    },
    automations: {
      helpTitle: "自动化",
      helpBody: "",
      newTask: "新建定时任务",
      taskName: "任务名称",
      taskNamePlaceholder: "例如：每日项目巡检",
      prompt: "任务内容",
      promptPlaceholder: "例如：每天检查这个项目并总结需要处理的问题。",
      workspace: "Workspace",
      chooseWorkspace: "选择 workspace",
      daily: "每天",
      scheduleTime: "运行时间",
      timezone: "时区",
      status: "状态",
      enableTask: "启用这个定时任务",
      active: "已启用",
      paused: "已暂停",
      schedulePreview: "计划",
      save: "保存定时任务",
      install: "启用",
      uninstall: "暂停",
      delete: "删除",
      installed: "已启用",
      generated: "已保存",
      draft: "已暂停",
      listTitle: "定时任务",
      activeGroup: "运行中",
      pausedGroup: "已暂停",
      noTasks: "暂无自动化任务",
      localRunner: "本机执行",
      logFile: "日志文件",
      command: "运行命令",
      skillReady: "Skill 已注入",
      bridgeReady: "Automation 工具已连接",
      bridgeDisabled: "先启用定时任务 Skill",
      cronActiveCount: (count: number) => `系统计划任务：${count} 个启用`,
      latestError: "最近错误",
      lastGenerated: "更新时间",
      lastInstalled: "启用时间",
      saved: "定时任务已保存",
      installedOk: "定时任务已启用",
      uninstalledOk: "定时任务已暂停",
      deletedOk: "定时任务已删除",
      confirmDelete: "删除这个定时任务？",
      failed: "定时任务操作失败"
    },
    remote: {
      accountTitle: "手机控制账号",
      accountLoggedOut: "未登录推送账号",
      accountPlaceholder: "邮箱 / 用户 ID",
      displayNamePlaceholder: "显示名称（可选）",
      login: "登录并绑定桌面端",
      logout: "退出登录",
      pairTitle: "手机配对",
      pairHint: "手机端使用同一账号和配对码完成绑定；普通用户不需要自备公网地址。",
      startPairing: "生成配对码",
      pairingCode: "配对码",
      pairingExpires: "过期时间",
      noDevices: "暂无已配对手机",
      pairedDevices: "已配对手机",
      revokeDevice: "移除设备",
      loginRequired: "请先登录推送账号",
      loginSaved: "推送账号已登录",
      logoutSaved: "已退出推送账号",
      pairingStarted: "配对码已生成",
      pairingFailed: "配对码生成失败",
      deviceRevoked: "设备已移除",
      enableMobile: "启用手机控制",
      allowControl: "允许手机下发控制指令",
      allowUpdates: "允许自动更新推送通知",
      bridgeRunning: "手机控制已运行",
      bridgeStopped: "手机控制未启动",
      tokenRequired: "手机控制需要访问密钥。",
      connectionAddress: "本地 Bridge 地址",
      accessKey: "访问密钥",
      localBridgeNote: "这里显示的是桌面本机/局域网地址，不是公开手机网页可用的公网地址。127.0.0.1 只能被这台电脑自己访问；正式发布需要云端中继或自动 HTTPS tunnel。",
      copyLanUrl: "复制本地地址",
      copyToken: "复制访问密钥",
      saveApply: "保存手机控制",
      restart: "重启",
      rotateToken: "更换访问密钥",
      testUpdate: "测试更新推送",
      saved: "手机控制配置已保存",
      running: "手机控制已运行",
      stopped: "手机控制未启动",
      tokenUpdated: "访问密钥已更新",
      statusLabel: "手机控制",
      testUpdateTitle: "DeepSeek TUI Desktop 更新",
      testUpdateBody: "自动更新推送通知接口已可用。",
      testUpdateSent: "已发送测试更新通知",
      testUpdateFailed: "更新通知发送失败",
      copied: (label: string) => `${label} 已复制`
    },
    settings: {
      language: "界面语言",
      languageHint: "切换后立即保存并应用到界面。",
      chinese: "中文",
      english: "English",
      chooseWorkspace: "选择 workspace",
      openCursor: "打开 Cursor",
      openVSCode: "打开 VS Code",
      chooseBinary: "选择 binary",
      customDeepseekPath: "Custom deepseek path",
      advancedRuntime: "高级运行设置",
      advancedRuntimeHint: "默认使用内置 DeepSeek TUI。只有需要切换 provider、运行路径或高级模型时再打开。",
      advancedModel: "高级模型",
      provider: "Provider",
      endpoint: "DeepSeek Endpoint",
      endpointStable: "正式版",
      endpointBeta: "测试版",
      endpointCustom: "自定义",
      endpointHint: "正式版保持默认；测试版和自定义只影响 DeepSeek provider。",
      model: "Model",
      modelDoc: "官方文档",
      apiModel: (model: string) => `API model：${model}`,
      baseUrl: "Base URL",
      apiKey: "DeepSeek API Key（全局）",
      apiKeyHint: "保存后作为全局登录密钥，之后所有 workspace 默认使用；不会写入项目历史。",
      deepseekKeyPlaceholder: "粘贴 DeepSeek API Key",
      nvidiaKeyPlaceholder: "粘贴 NVIDIA NIM API Key",
	      processStream: "开启流式输出",
	      processStreamHint: "打开后右侧显示运行过程，并在启动时启用流式过程输出；关闭后只保留主对话回复。",
	      thinkingMode: "Thinking 模式",
	      thinkingModeHint: "默认 Max；High 保留较强推理但输出更克制，Off 关闭思考过程。",
	      skillRoutingMode: "Skill 路由",
	      skillRoutingModeHint: "Auto 会按本轮任务选择 Skill；Manual 只响应 /skill-name；All 保持旧的全量注入。",
	      modelRoutingMode: "模型路由",
	      modelRoutingModeHint: "Auto 会让短任务走 Flash、计划/审查/长任务走 Pro；Manual 保持手动选择。",
	      layeredContext: "分层上下文保留",
	      layeredContextHint: "默认开启后，长任务会先生成 append-only context seams，再进入 hard cycle，减少忘记前文的情况。",
	      contextVerbatimWindowTurns: "最近逐字保留轮数",
	      contextVerbatimWindowTurnsHint: "最近 N 轮保持原文，其余更早内容交给 seam 摘要。建议保持在 8-32 之间。",
	      allowShell: "Allow shell",
	      agents: "Agents",
	      setup: "Setup",
      apiKeySaveFailed: "API Key 保存失败",
      save: "保存设置"
    },
    category: {
      All: "全部",
      Coding: "编码",
      Browser: "浏览器",
      Data: "数据",
      Knowledge: "知识",
      Productivity: "效率",
      Remote: "远程"
    },
    auth: {
      None: "无需认证",
      Token: "Token",
      Connection: "连接串",
      OAuth: "OAuth"
    },
    safety: {
      Low: "低",
      Medium: "中",
      High: "高"
    },
    downloadsCommunity: "社区"
  },
  en: {
    status: {
      ready: "Ready",
      checking: "Checking",
      missing: "Missing",
      runtimeReady: "Ready",
      launching: "Launching",
      runningPid: (pid?: number) => pid ? `Running pid ${pid}` : "Running",
      launchFailed: "Launch failed",
      stopped: "Stopped",
      settingsSaved: "Settings saved",
      languageSaved: "Language switched",
      editorOpened: (editor: string) => `Opened ${editor}`,
      exited: (exitCode?: number) => `Exited ${exitCode ?? ""}`.trim()
    },
    welcome: {
      title: "DeepSeek TUI Desktop",
      content: "Choose a project folder to start chatting. Model and run mode can be changed on the main screen."
    },
    newConversation: {
      title: "New chat",
      content: "Choose a workspace, then enter a task to begin."
    },
    promptResult: {
      planTitle: "Plan",
      harnessTitle: "Agent",
      yoloTitle: "YOLO",
      planContent: "DeepSeek TUI is in Plan mode and is analyzing the goal before producing a non-mutating plan.",
      execContent: "DeepSeek TUI Agent is reading the workspace, using tools, and working on this task. The main reply will appear here when it finishes.",
      yoloContent: "DeepSeek TUI YOLO mode is handling this task with high permissions. The main reply will appear here when it finishes."
    },
    runSummary: {
      title: "DeepSeek TUI reply",
      status: "Status",
      mode: "Mode",
      workspace: "Workspace",
      started: "Started",
      terminal: "Process excerpt",
      success: "Completed",
      failed: "Failed",
      noOutput: "Completed.",
      failedShort: "Not completed. See the run summary.",
      completedShort: "Completed."
    },
    sidebar: {
      subtitle: "Desktop",
      newChat: "New chat",
      navLabel: "Conversations",
      assistant: "DeepSeek coding assistant",
      running: "Running",
      automations: "Scheduled Skill",
      remote: "Mobile Control",
      git: "GitHub Versions",
      settings: "Settings"
    },
    history: {
      noProject: "No project",
      untitled: "New session",
      empty: "No saved sessions",
      deleteSession: "Delete session",
      selectProject: "Select project",
      newProjectSession: "New chat in this project",
      sessions: (count: number) => `${count} sessions`
    },
    topbar: {
      title: "DeepSeek coding chat",
      noWorkspace: "No workspace selected",
      viewSwitch: "UI view switch",
	      chat: "Chat",
	      tools: "Tools",
      checkRuntime: "Check runtime",
      chooseWorkspace: "Choose workspace",
      currentBranch: "Current branch",
      noBranch: "No branch detected",
      updateAvailable: (version: string) => `Update ${version}`,
      openCursor: "Open Cursor",
      apiKeySaved: "API Key saved",
      apiKeyMissing: "Set API Key",
      remoteStopped: "Mobile control stopped"
    },
    tools: {
      enabledMcp: "Selected MCP",
      enabledSkills: "Enabled Skills",
      enabledAutomations: "Active scheduled tasks",
      installablePresets: "Installable presets",
      automationsDesc: "Keep only the task prompt, workspace, daily run time, and active status.",
      manageAutomations: "Manage scheduled tasks",
      mcpStatus: "MCP tool status",
      mcpStatusDesc: "MCP connects the Agent to external tools such as browsers, GitHub, and databases. Token or URL based tools can be configured locally before launch.",
      manageMcp: "Manage MCP",
      off: "Off",
      enabled: "Enabled",
      selected: "Selected",
      skillsDesc: "Skills are Markdown instructions you can create, import, and enable for specific work.",
      manageSkills: "Manage Skills"
	    },
	    runtimeApi: {
	      title: "AppService",
	      subtitle: "The upstream Runtime HTTP API is connected incrementally; main chat still uses the existing CLI runner.",
	      connected: "Connected",
	      starting: "Starting",
	      idle: "Idle",
	      stopped: "Stopped",
	      error: "Error",
	      refresh: "Refresh",
	      runtimeInfo: "Runtime info",
	      skills: "Skills status",
	      mcp: "MCP servers",
	      approvals: "Approval events",
	      noSkills: "Runtime API has not returned skills.",
	      noMcp: "Runtime API has not returned MCP servers.",
	      noApprovals: "No pending approvals.",
	      authRequired: "Bearer token enabled",
	      authOff: "Auth disabled",
	      unavailable: "Runtime API is unavailable; the main chat CLI runner is unaffected.",
	      toggleFailed: "Skill update failed"
	    },
	    runtimeContext: {
	      title: "Context retention",
	      enabled: "Layered context on",
	      disabled: "Layered context off",
	      recentTurns: (count: number) => `${count} recent turns kept verbatim`,
	      seams: (count: number) => `${count} seam${count === 1 ? "" : "s"}`,
	      compactions: (count: number) => `${count} compaction${count === 1 ? "" : "s"}`,
	      approvals: (count: number) => `${count} approval${count === 1 ? "" : "s"} pending`,
	      questions: (count: number) => `${count} question${count === 1 ? "" : "s"} pending`,
	      waiting: "Waiting for input",
	      running: "Running",
	      completed: "Turn complete",
	      recall: "Recall archive",
	      recallHint: "Use this when a long task crossed a cycle or compaction and you want the runtime to pull archived context back into the task.",
	      pin: "Pin anchor",
	      noAnchors: "No pinned anchors yet. Save the stable constraints that the task should keep."
	    },
	    terminal: {
	      streamTitle: "Streaming output",
	      clear: "Clear output",
	      stop: "Stop",
	      bootReady: "Terminal is ready.\r\n",
	      bootHint: "Run output will appear here.\r\n\r\n"
	    },
	    runtimeAgents: {
	      title: "Agent Runtime",
	      subtitle: "Structured state uses the runtime API when available and falls back to terminal events.",
	      status: "Status",
	      source: "Source",
	      mode: "Mode",
	      workspace: "Workspace",
	      started: "Started",
		      noAgents: "No agents detected yet.",
          trackedCount: (count: number) => `${count} agent${count === 1 ? "" : "s"} detected`,
          runningCount: (count: number) => `${count} agent${count === 1 ? "" : "s"} running now`,
	      recentEvents: "Recent events",
	      noEvents: "No runtime events yet.",
	      counts: (running: number, completed: number, failed: number) => `${running} running / ${completed} completed / ${failed} failed`,
	      statuses: {
	        idle: "Idle",
	        running: "Running",
	        completed: "Completed",
	        failed: "Failed",
	        stopped: "Stopped",
	        queued: "Queued",
	        cancelling: "Cancelling",
	        cancelled: "Cancelled"
	      }
	    },
	    composer: {
      modeLabel: "Run mode",
      modelLabel: "Model",
      stop: "Stop",
      planPlaceholder: "Describe the goal. Plan mode will only produce a plan and will not edit files...",
      execPlaceholder: "Give Agent mode a coding task...",
      yoloPlaceholder: "Give YOLO mode a high-permission task..."
    },
    inspector: {
      titles: {
        skills: "Skills",
        mcp: "MCP presets",
        automations: "Scheduled Tasks",
        remote: "Mobile Control",
        git: "GitHub Versions",
        settings: "Settings"
      },
      subtitles: {
        skills: "Create, import, and enable launch-time Skills",
        mcp: "Enable presets or add custom MCP servers",
        automations: "Guide the Agent through local schedules as a Skill",
        remote: "Mobile progress, controls, and update alerts",
        git: "View branches, remotes, changes, commits, and pushes",
        settings: "Workspace, runtime, and Agent parameters"
      },
      close: "Close"
    },
    skills: {
      customDirPlaceholder: "Optional: custom skills directory",
      chooseDir: "Choose skills directory",
      save: "Save Skills",
      enableRuntime: "Inject Skills on launch",
      runtimeHint: "When off, you can still create and import Skills, but the runtime will not load them at launch.",
      createTitle: "New Skill",
      createName: "Name",
      createNamePlaceholder: "Daily report check",
      createDescription: "Trigger",
      createDescriptionPlaceholder: "Use when...",
      createSkill: "Create Skill",
      importSkill: "Import Skills",
      importFailed: "Import failed",
      created: (path: string) => `Skill created: ${path}`,
      imported: (count: number) => `${count} Skill${count === 1 ? "" : "s"} imported`,
      saveFailed: "Skill save failed",
      scheduledOpened: "Scheduled tasks are now injected as a default Skill. When enabled, schedule, reminder, daily, hourly, or run-later requests should trigger it in chat.",
      customCategory: "Custom",
      defaultTag: "Default",
      fileTag: "File"
    },
    mcp: {
      helpTitle: "What MCP Does",
      helpBody: "MCP is a tool socket for the Agent. This panel selects presets and adds custom MCP servers; the runtime only receives MCP after you turn on launch-time MCP.",
      searchPlaceholder: "Search MCP, commands, categories...",
      summaryEnabled: (count: number) => `${count} selected`,
      summaryVisible: (count: number) => `${count} visible`,
      summaryInstalled: (count: number) => `${count} built-in presets`,
      customConfigPlaceholder: "Optional: use an existing MCP JSON file",
      chooseConfig: "Choose MCP config",
      save: "Save MCP",
      enableRuntime: "Enable MCP at launch",
      runtimeHint: "Off by default. You can still select, add, and preflight MCP servers, but DEEPSEEK_MCP_CONFIG is not set and services are not started.",
      runtimeOn: "MCP will be injected at launch",
      runtimePending: "MCP is on, but no injectable config is selected yet",
      runtimeOff: "MCP will not be injected at launch",
      runtimeBlocked: "MCP is selected but not configured, so it will not be injected at launch.",
      riskSuffix: "risk",
      sourceCustom: "Loaded from custom JSON",
      configFailed: "MCP JSON save failed",
      test: "Preflight MCP",
      testing: "Checking MCP...",
      testOk: "MCP preflight passed",
      testFailed: "MCP preflight found issues",
      adapterTitle: "MCP adapter status",
      adapterDesc: "Only MCP servers marked startable are written to runtime config. Missing tokens, URLs, or commands keep the server selected but not started.",
      setupTitle: "Service setup guide",
      setupDesc: "Opening MCP starts here: search for a service, then enter its token, OAuth URL, login detail, or connection string. Saving selects and enables it.",
      setupEmptyTitle: "No MCP matches",
      setupEmptyBody: "Try another keyword or add a custom MCP below.",
      selectFirst: "Select GitHub and configure",
      chooseService: "Select and configure",
      selected: "Selected",
      notSelected: "Not selected",
      selectedNoAuth: (name: string) => `${name} selected and enabled. No credential is required.`,
      secretSavedAndEnabled: (key: string) => `${key} saved. MCP selected and enabled.`,
      noMatches: "No search results",
      openGuide: "Open setup page",
      noAuthRequired: "No credential needed",
      configureEnvKey: (key: string) => `Configure ${key}`,
      getToken: "Get token",
      oauthLogin: "OAuth / login",
      connectionSetup: "Open connection setup",
      viewDocs: "View setup guide",
      ready: "Startable",
      needsAuth: "Needs auth",
      needsConfig: "Needs config",
      commandMissing: "Command missing",
      invalidUrl: "Invalid URL",
      untested: "Needs check",
      injectable: "Will start",
      notInjected: "Will not start",
      configureSecret: "Configure",
      secretPlaceholder: "Paste token / URL / connection string",
      saveSecret: "Save config",
      secretSaved: (key: string) => `${key} saved`,
      secretFailed: "Config save failed",
      guide: "Setup guide",
      noServers: "No MCP servers are selected and no custom MCP JSON is set.",
      customTitle: "Add MCP",
      customHint: "Add a command-based or URL-based MCP server and save it directly as the custom MCP config.",
      customId: "Server ID",
      customIdPlaceholder: "my-server",
      customCommand: "Command",
      customCommandPlaceholder: "npx / node / uvx / python",
      customArgs: "Args",
      customArgsPlaceholder: "-y\n@modelcontextprotocol/server-memory",
      customUrl: "URL",
      customUrlPlaceholder: "https://example.com/mcp",
      customEnv: "Env JSON",
      customEnvPlaceholder: "{\"TOKEN\":\"\"}",
      addCustom: "Add MCP",
      customAdded: (id: string) => `MCP added: ${id}`,
      customInvalidId: "Server ID can only use letters, numbers, dots, underscores, and hyphens.",
      customMissingTarget: "Enter a Command or URL.",
      customInvalidJson: "MCP JSON or Env JSON is invalid."
    },
    git: {
      repoReady: "Git repository connected",
      notRepoTitle: "Current workspace is not a Git repository",
      notRepoBody: "Initialize Git before binding a GitHub remote, committing, or pushing.",
      repoRoot: "Repository root",
      branch: "Branch",
      upstream: "Upstream",
      remote: "GitHub remote",
      noRemote: "No origin remote",
      remotePlaceholder: "https://github.com/owner/repo.git or git@github.com:owner/repo.git",
      init: "Initialize Git",
      saveRemote: "Save remote",
      copyRemote: "Copy remote",
      switchBranch: "Switch branch",
      switchBranchOk: "Branch switched",
      dirtyBranchBlocked: "Commit or stash local changes before switching branches.",
      localBranch: "Local",
      remoteBranch: "Remote",
      refresh: "Refresh",
      fetch: "Fetch",
      pull: "Pull",
      push: "Push",
      changes: "Changes",
      noChanges: "Working tree clean",
      staged: "Staged",
      unstaged: "Unstaged",
      untracked: "Untracked",
      commitMessage: "Commit message",
      commitPlaceholder: "Describe this change",
      commit: "Stage all + Commit",
      preview: "Preview commit scope",
      previewTitle: "Pre-commit Preview",
      previewOk: "Generated pre-commit preview",
      lastCommit: "Last commit",
      noCommit: "No commits yet",
      aheadBehind: (ahead: number, behind: number) => `ahead ${ahead} / behind ${behind}`,
      initOk: "Git repository initialized",
      remoteOk: "GitHub remote saved",
      fetchOk: "Fetch complete",
      pullOk: "Pull complete",
      pushOk: "Push complete",
      commitOk: "Commit created",
      copied: "Remote copied",
      actionFailed: "Git action failed"
    },
    automations: {
      helpTitle: "Automations",
      helpBody: "",
      newTask: "New scheduled task",
      taskName: "Task name",
      taskNamePlaceholder: "Example: Daily project check",
      prompt: "Task prompt",
      promptPlaceholder: "Example: Check this project every day and summarize items that need attention.",
      workspace: "Workspace",
      chooseWorkspace: "Choose workspace",
      daily: "Daily",
      scheduleTime: "Run time",
      timezone: "Timezone",
      status: "Status",
      enableTask: "Enable this scheduled task",
      active: "Active",
      paused: "Paused",
      schedulePreview: "Schedule",
      save: "Save scheduled task",
      install: "Activate",
      uninstall: "Pause",
      delete: "Delete",
      installed: "Active",
      generated: "Saved",
      draft: "Paused",
      listTitle: "Scheduled tasks",
      activeGroup: "Active",
      pausedGroup: "Paused",
      noTasks: "No automations yet.",
      localRunner: "Local runner",
      logFile: "Log file",
      command: "Run command",
      skillReady: "Skill injected",
      bridgeReady: "Automation tools connected",
      bridgeDisabled: "Enable the scheduled task Skill first",
      cronActiveCount: (count: number) => `System schedules: ${count} active`,
      latestError: "Latest error",
      lastGenerated: "Updated",
      lastInstalled: "Activated",
      saved: "Scheduled task saved",
      installedOk: "Scheduled task activated",
      uninstalledOk: "Scheduled task paused",
      deletedOk: "Scheduled task deleted",
      confirmDelete: "Delete this scheduled task?",
      failed: "Scheduled task action failed"
    },
    remote: {
      accountTitle: "Mobile control account",
      accountLoggedOut: "No push account signed in",
      accountPlaceholder: "Email / user ID",
      displayNamePlaceholder: "Display name (optional)",
      login: "Sign in and bind desktop",
      logout: "Sign out",
      pairTitle: "Phone pairing",
      pairHint: "Use the same account plus this code in the phone app. Normal users should not bring a public address.",
      startPairing: "Generate pairing code",
      pairingCode: "Pairing code",
      pairingExpires: "Expires",
      noDevices: "No paired phones yet",
      pairedDevices: "Paired phones",
      revokeDevice: "Remove device",
      loginRequired: "Sign in to the push account first",
      loginSaved: "Push account signed in",
      logoutSaved: "Signed out from push account",
      pairingStarted: "Pairing code generated",
      pairingFailed: "Pairing code failed",
      deviceRevoked: "Device removed",
      enableMobile: "Enable mobile control",
      allowControl: "Allow phone control commands",
      allowUpdates: "Allow automatic update push notifications",
      bridgeRunning: "Mobile control running",
      bridgeStopped: "Mobile control stopped",
      tokenRequired: "Mobile control requires an access key.",
      connectionAddress: "Local Bridge address",
      accessKey: "Access key",
      localBridgeNote: "This is a desktop-local or LAN address, not a public mobile-web Bridge address. 127.0.0.1 is only reachable from this computer; public release needs a cloud relay or automatic HTTPS tunnel.",
      copyLanUrl: "Copy local address",
      copyToken: "Copy access key",
      saveApply: "Save mobile control",
      restart: "Restart",
      rotateToken: "Rotate access key",
      testUpdate: "Test update push",
      saved: "Mobile control settings saved",
      running: "Mobile control is running",
      stopped: "Mobile control is not running",
      tokenUpdated: "Access key updated",
      statusLabel: "Mobile control",
      testUpdateTitle: "DeepSeek TUI Desktop update",
      testUpdateBody: "The automatic update push API is available.",
      testUpdateSent: "Test update notification sent",
      testUpdateFailed: "Update notification failed",
      copied: (label: string) => `${label} copied`
    },
    settings: {
      language: "Interface language",
      languageHint: "Switching applies and saves immediately.",
      chinese: "中文",
      english: "English",
      chooseWorkspace: "Choose workspace",
      openCursor: "Open Cursor",
      openVSCode: "Open VS Code",
      chooseBinary: "Choose binary",
      customDeepseekPath: "Custom deepseek path",
      advancedRuntime: "Advanced runtime settings",
      advancedRuntimeHint: "The bundled DeepSeek TUI runtime is used by default. Open only when changing provider, runtime path, or advanced model choices.",
      advancedModel: "Advanced model",
      provider: "Provider",
      endpoint: "DeepSeek Endpoint",
      endpointStable: "Stable",
      endpointBeta: "Beta",
      endpointCustom: "Custom",
      endpointHint: "Stable remains the default; beta and custom only affect the DeepSeek provider.",
      model: "Model",
      modelDoc: "Official docs",
      apiModel: (model: string) => `API model: ${model}`,
      baseUrl: "Base URL",
      apiKey: "DeepSeek API Key (global)",
      apiKeyHint: "Saved as a global sign-in key and reused for every workspace; it is not written to project history.",
      deepseekKeyPlaceholder: "Paste DeepSeek API Key",
      nvidiaKeyPlaceholder: "Paste NVIDIA NIM API Key",
	      processStream: "Enable streaming output",
	      processStreamHint: "When enabled, the right-side run stream is shown and runtime process output is requested at launch. When disabled, only the main chat reply is kept.",
	      thinkingMode: "Thinking mode",
	      thinkingModeHint: "Defaults to Max. High keeps strong reasoning with a quieter stream; Off disables thinking output.",
	      skillRoutingMode: "Skill routing",
	      skillRoutingModeHint: "Auto selects Skills per turn; Manual only honors /skill-name; All keeps the previous always-on behavior.",
	      modelRoutingMode: "Model routing",
	      modelRoutingModeHint: "Auto sends short turns to Flash and planning/review/long tasks to Pro; Manual keeps the selected model.",
	      layeredContext: "Layered context retention",
	      layeredContextHint: "When enabled, long tasks produce append-only context seams before a hard cycle, which reduces dropped details across long runs.",
	      contextVerbatimWindowTurns: "Recent verbatim turns",
	      contextVerbatimWindowTurnsHint: "Keeps the most recent N turns verbatim and lets older turns move behind seam summaries. A range of 8-32 is usually enough.",
	      allowShell: "Allow shell",
	      agents: "Agents",
	      setup: "Setup",
      apiKeySaveFailed: "API key save failed",
      save: "Save settings"
    },
    category: {
      All: "All",
      Coding: "Coding",
      Browser: "Browser",
      Data: "Data",
      Knowledge: "Knowledge",
      Productivity: "Productivity",
      Remote: "Remote"
    },
    auth: {
      None: "None",
      Token: "Token",
      Connection: "Connection",
      OAuth: "OAuth"
    },
    safety: {
      Low: "Low",
      Medium: "Medium",
      High: "High"
    },
    downloadsCommunity: "community"
  }
} as const;

const skillTranslations: Record<AppLanguage, Record<string, Partial<Pick<SkillPreset, "name" | "description" | "category">>>> = {
  zh: {},
  en: {
    superpowers: {
      name: "Superpowers",
      description: "Default workflow for planning, task decomposition, code edits, and self-checks.",
      category: "Agent"
    },
    "ui-ux-pro-max": {
      name: "UI/UX Pro Max",
      description: "Complete UI/UX Pro Max design intelligence with searchable styles, palettes, typography, charts, UX rules, and stack guidance.",
      category: "Design"
    },
    "scheduled-task-agent": {
      name: "Scheduled Task Agent",
      description: "Handles normal scheduled task requests as an Agent Skill: clarify task, time, and workspace, then produce cron, launchd, or one-off script artifacts.",
      category: "Scheduled Tasks"
    },
    "cron-scheduler": {
      name: "Cron Advanced Scripts",
      description: "Advanced-only helper for hand-authored crontab files; normal scheduled tasks are handled by the Scheduled Task Agent Skill.",
      category: "Scheduled Tasks"
    },
    "skill-downloader": {
      name: "Skill Download",
      description: "Guides the Agent to download Skills with curl, save SKILL.md, and verify the source instead of synthesizing similar content.",
      category: "Skills"
    }
  }
};

const mcpTranslations: Record<AppLanguage, Record<string, Partial<Pick<McpPreset, "name" | "description" | "envHint">>>> = {
  zh: {},
  en: {
    playwright: {
      description: "Browser automation, page inspection, and end-to-end testing. Common in Cursor and Claude development flows.",
      envHint: "No token required"
    },
    context7: {
      description: "Provides the Agent with current framework and library docs, useful for official API lookup while coding.",
      envHint: "No token required"
    },
    filesystem: {
      description: "Exposes the current workspace as MCP file context for the Agent.",
      envHint: "Workspace path"
    },
    "mcp-remote": {
      description: "Connects local-only clients to remote MCP servers, useful for OAuth and hosted MCP bridging.",
      envHint: "MCP_REMOTE_URL"
    },
    github: {
      description: "Connects repositories, issues, pull requests, and code search. Requires a GitHub token.",
      envHint: "GITHUB_PERSONAL_ACCESS_TOKEN"
    },
    postgres: {
      description: "Read-only PostgreSQL schema and data queries, useful for full-stack debugging.",
      envHint: "POSTGRES_CONNECTION_STRING"
    },
    "sequential-thinking": {
      description: "Step-by-step reasoning and planning tool for complex debugging and solution design.",
      envHint: "No token required"
    },
    memory: {
      description: "Knowledge-graph style long-term memory for saving project facts across sessions.",
      envHint: "Local storage"
    },
    slack: {
      description: "Reads and sends Slack workspace information for team collaboration workflows.",
      envHint: "SLACK_BOT_TOKEN, SLACK_TEAM_ID"
    },
    notion: {
      description: "Official Notion MCP for reading and managing Notion pages and databases.",
      envHint: "NOTION_TOKEN"
    },
    sentry: {
      description: "Official Sentry MCP for reading errors, projects, and event context.",
      envHint: "SENTRY_ACCESS_TOKEN"
    },
    figma: {
      name: "Figma Developer",
      description: "Lets the Agent read Figma design data to assist UI implementation.",
      envHint: "FIGMA_API_KEY"
    },
    stripe: {
      description: "Official Stripe MCP for payments, subscriptions, invoices, and customer data operations.",
      envHint: "STRIPE_SECRET_KEY"
    },
    puppeteer: {
      description: "Classic browser automation MCP for screenshots, scraping, and form flows.",
      envHint: "No token required"
    },
    "brave-search": {
      description: "Web search MCP for external search when you do not want to attach a browser.",
      envHint: "BRAVE_API_KEY"
    },
    "google-maps": {
      description: "Location, route, and place lookup MCP.",
      envHint: "GOOGLE_MAPS_API_KEY"
    },
    pannel: {
      name: "Panel / 1Panel",
      description: "1Panel server-panel management MCP for reading websites, databases, apps, and panel status.",
      envHint: "PANEL_HOST, PANEL_ACCESS_TOKEN"
    }
  }
};

function isRuntimeReady(runtime: RuntimeCheck | null) {
  return Boolean(runtime?.selectedExists);
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultBaseUrlForProvider(provider: ProviderMode) {
  return provider === "nvidia-nim" ? NVIDIA_NIM_BASE_URL : DEEPSEEK_BASE_URL;
}

function deepSeekEndpointModeForBaseUrl(baseUrl: string): DeepSeekEndpointMode {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalized || normalized === DEEPSEEK_BASE_URL) return "stable";
  if (normalized === DEEPSEEK_BETA_BASE_URL) return "beta";
  return "custom";
}

function baseUrlForDeepSeekEndpointMode(mode: DeepSeekEndpointMode, currentBaseUrl: string) {
  if (mode === "stable") return DEEPSEEK_BASE_URL;
  if (mode === "beta") return DEEPSEEK_BETA_BASE_URL;
  return currentBaseUrl || DEEPSEEK_BASE_URL;
}

function normalizeSettings(settings: DesktopSettings): DesktopSettings {
  const provider = settings.provider || "deepseek";
  const language = settings.language === "en" ? "en" : "zh";
  return {
    ...settings,
    language,
    provider,
    model: provider === "deepseek"
      ? normalizeDeepSeekModelSelection(settings.model)
      : settings.model || DEFAULT_DEEPSEEK_MODEL,
    baseUrl: settings.baseUrl || defaultBaseUrlForProvider(provider),
    thinkingMode: normalizeDeepSeekThinkingMode(settings.thinkingMode),
    skillRoutingMode: ["auto", "manual", "all"].includes(settings.skillRoutingMode) ? settings.skillRoutingMode : "auto",
    modelRoutingMode: settings.modelRoutingMode === "manual" ? "manual" : "auto",
    layeredContextEnabled: settings.layeredContextEnabled !== false,
    contextVerbatimWindowTurns: normalizeContextVerbatimWindowTurns(settings.contextVerbatimWindowTurns)
  };
}

function normalizeContextVerbatimWindowTurns(value: number) {
  const turns = Number(value);
  if (!Number.isInteger(turns)) return 16;
  return Math.min(64, Math.max(4, turns));
}

function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function createAutomationDraft(settings: DesktopSettings, task?: AutomationTask | null): AutomationDraft {
  const status = task?.status || (task?.installed || task?.enabled ? "ACTIVE" : "PAUSED");
  return {
    id: task?.id,
    name: task?.name || "",
    prompt: task?.prompt || "",
    workspacePath: task?.workspacePath || settings.workspacePath,
    minute: task?.minute ?? 0,
    hour: task?.hour ?? 9,
    timezone: task?.timezone || defaultTimezone(),
    status: task ? status : "ACTIVE"
  };
}

function automationStatus(task: AutomationTask) {
  return task.status || (task.installed || task.enabled ? "ACTIVE" : "PAUSED");
}

function automationTimeValue(hour: number, minute: number) {
  const safeHour = String(clampNumber(hour, 0, 23)).padStart(2, "0");
  const safeMinute = String(clampNumber(minute, 0, 59)).padStart(2, "0");
  return `${safeHour}:${safeMinute}`;
}

function parseAutomationTime(value: string) {
  const [hourRaw, minuteRaw] = value.split(":");
  return {
    hour: clampNumber(Number(hourRaw), 0, 23),
    minute: clampNumber(Number(minuteRaw), 0, 59)
  };
}

function automationSchedulePreview(draft: AutomationDraft, language: AppLanguage) {
  const minute = clampNumber(draft.minute, 0, 59);
  const hour = clampNumber(draft.hour, 0, 23);
  const time = automationTimeValue(hour, minute);
  return language === "zh" ? `每天 ${time}` : `Daily ${time}`;
}

function formatAutomationTime(value: string, language: AppLanguage) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function getSkillText(skill: SkillPreset, language: AppLanguage) {
  const translation = skillTranslations[language][skill.id];
  return {
    name: translation?.name || skill.name,
    description: translation?.description || skill.description,
    category: translation?.category || skill.category
  };
}

function fallbackSkillPreset(template: SkillTemplateDraft, language: AppLanguage): SkillPreset {
  const customCategory = uiCopy[language].skills.customCategory;
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    icon: "zap",
    category: customCategory,
    tools: ["SKILL.md"]
  };
}

function getMcpText(preset: McpPreset, language: AppLanguage) {
  const translation = mcpTranslations[language][preset.id];
  return {
    name: translation?.name || preset.name,
    description: translation?.description || preset.description,
    envHint: translation?.envHint || preset.envHint
  };
}

function mcpEnvKeysFromHint(value: string) {
  return String(value || "")
    .split(/[,\s/]+/)
    .map((item) => item.trim())
    .filter((item) => /^[A-Z0-9_]+$/.test(item));
}

function mcpGuideForPreset(preset: McpPreset, language: AppLanguage) {
  const guides: Record<string, string> = {
    github: "https://github.com/settings/tokens",
    "mcp-remote": "https://www.npmjs.com/package/mcp-remote",
    postgres: "https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING",
    slack: "https://api.slack.com/apps",
    notion: "https://www.notion.so/profile/integrations",
    sentry: "https://sentry.io/settings/account/api/auth-tokens/",
    figma: "https://www.figma.com/developers/api#access-tokens",
    stripe: "https://dashboard.stripe.com/apikeys",
    "brave-search": "https://api.search.brave.com/app/keys",
    "google-maps": "https://console.cloud.google.com/google/maps-apis/credentials",
    pannel: "https://github.com/1Panel-dev/mcp-1panel"
  };
  return {
    url: guides[preset.id] || "",
    label: language === "zh" ? "打开配置页面" : "Open setup page"
  };
}

function mcpGuideActionLabel(preset: McpPreset, language: AppLanguage) {
  if (preset.auth === "Token") {
    return language === "zh" ? uiCopy.zh.mcp.getToken : uiCopy.en.mcp.getToken;
  }
  if (preset.auth === "OAuth") {
    return language === "zh" ? uiCopy.zh.mcp.oauthLogin : uiCopy.en.mcp.oauthLogin;
  }
  if (preset.auth === "Connection") {
    return language === "zh" ? uiCopy.zh.mcp.connectionSetup : uiCopy.en.mcp.connectionSetup;
  }
  return language === "zh" ? uiCopy.zh.mcp.viewDocs : uiCopy.en.mcp.viewDocs;
}

function mcpSetupButtonLabel(auth: McpPreset["auth"], key: string, language: AppLanguage) {
  if (auth === "OAuth") {
    return language === "zh" ? `配置 ${key || "OAuth"}` : `Configure ${key || "OAuth"}`;
  }
  if (auth === "Connection") {
    return language === "zh" ? `输入 ${key || "连接串"}` : `Enter ${key || "connection"}`;
  }
  if (/TOKEN|SECRET|API_KEY|ACCESS_KEY/i.test(key)) {
    return language === "zh" ? "输入 token" : "Enter token";
  }
  return language === "zh" ? `配置 ${key}` : `Configure ${key}`;
}

function mcpSecretPlaceholderForKey(key: string, language: AppLanguage) {
  if (/URL|HOST/i.test(key)) {
    return language === "zh" ? "粘贴登录地址 / MCP URL" : "Paste login address / MCP URL";
  }
  if (/CONNECTION/i.test(key)) {
    return language === "zh" ? "粘贴连接串" : "Paste connection string";
  }
  if (/TEAM_ID/i.test(key)) {
    return language === "zh" ? "粘贴 Team ID" : "Paste team ID";
  }
  return language === "zh" ? "粘贴 token 或 API key" : "Paste token or API key";
}

function mcpArgsFromLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseMcpEnv(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("env");
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, val]) => [key, String(val ?? "")]));
}

function parseMcpConfigDraft(value: string) {
  const parsed = JSON.parse(value.trim() || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config");
  }
  const config = parsed as { servers?: unknown; [key: string]: unknown };
  if (!config.servers || typeof config.servers !== "object" || Array.isArray(config.servers)) {
    config.servers = {};
  }
  return config as { servers: Record<string, unknown>; [key: string]: unknown };
}

function formatStatus(status: StatusState, language: AppLanguage) {
  const copy = uiCopy[language].status;
  switch (status.type) {
    case "launching":
      return copy.launching;
    case "running":
      return copy.runningPid(status.pid);
    case "stopped":
      return copy.stopped;
    case "settingsSaved":
      return copy.settingsSaved;
    case "languageSaved":
      return copy.languageSaved;
    case "editorOpened":
      return copy.editorOpened(status.editor);
    case "exited":
      return copy.exited(status.exitCode);
    case "error":
      return status.message;
    case "ready":
    default:
      return copy.ready;
  }
}

function createEmptyRuntimeSnapshot(): RuntimeSnapshot {
  const updatedAt = new Date().toISOString();
  return {
    status: "idle",
    source: "none",
    sessionId: "",
    mode: "",
    workspacePath: "",
    pid: 0,
    command: "",
    args: [],
    startedAt: "",
    updatedAt,
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
}

function createEmptyRuntimeOrchestratorSnapshot(): RuntimeOrchestratorSnapshot {
  return {
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
}

function runtimeStatusText(status: RuntimeRunStatus | RuntimeAgentStatus, language: AppLanguage) {
  return uiCopy[language].runtimeAgents.statuses[status] || status;
}

function taskBoardStatusText(status: TaskBoardItem["status"], language: AppLanguage) {
  const zh: Record<TaskBoardItem["status"], string> = {
    draft: "待确认",
    queued: "排队",
    running: "运行中",
    completed: "完成",
    failed: "失败",
    blocked: "阻塞"
  };
  const en: Record<TaskBoardItem["status"], string> = {
    draft: "Draft",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    blocked: "Blocked"
  };
  return language === "zh" ? zh[status] : en[status];
}

function taskBoardRoleText(role: TaskAgentRole, language: AppLanguage) {
  const zh: Record<TaskAgentRole, string> = {
    planner: "规划",
    explorer: "探索",
    worker: "实现",
    reviewer: "审查",
    tester: "测试",
    "build-fixer": "构建修复"
  };
  const en: Record<TaskAgentRole, string> = {
    planner: "Planner",
    explorer: "Explorer",
    worker: "Worker",
    reviewer: "Reviewer",
    tester: "Tester",
    "build-fixer": "Build Fixer"
  };
  return language === "zh" ? zh[role] : en[role];
}

function latestRuntimeAssistantText(detail: RuntimeApiThreadDetail | null | undefined) {
  return conversationMessagesFromRuntimeDetail(detail)
    .filter((message) => message.role === "assistant")
    .at(-1)?.content || "";
}

function waitForMs(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function RunningActivityMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "running-activity-mark compact" : "running-activity-mark"} aria-hidden>
      <Fish className="running-fish" size={compact ? 14 : 16} />
      <span className="running-spray">
        <Droplets size={compact ? 10 : 12} />
        <Waves size={compact ? 12 : 14} />
      </span>
    </span>
  );
}

function gitStatusLabel(change: GitChangeInfo) {
  if (change.untracked) return "NEW";
  const status = change.status.trim();
  if (!status) return "MOD";
  if (status.includes("A")) return "ADD";
  if (status.includes("D")) return "DEL";
  if (status.includes("R")) return "REN";
  if (status.includes("M")) return "MOD";
  return status;
}

function gitStatusSummary(status: GitStatus | null, language: AppLanguage) {
  if (!status) return "";
  if (!status.isRepo) return uiCopy[language].git.notRepoTitle;
  if (!status.hasChanges) return uiCopy[language].git.noChanges;
  return [
    `${uiCopy[language].git.staged} ${status.staged}`,
    `${uiCopy[language].git.unstaged} ${status.unstaged}`,
    `${uiCopy[language].git.untracked} ${status.untracked}`
  ].join(" · ");
}

function createWelcomeMessage(language: AppLanguage): ChatMessage {
  return {
    id: "welcome",
    role: "assistant",
    title: uiCopy[language].welcome.title,
    content: uiCopy[language].welcome.content
  };
}

function createNewConversationMessage(language: AppLanguage): ChatMessage {
  return {
    id: createId(),
    role: "assistant",
    title: uiCopy[language].newConversation.title,
    content: uiCopy[language].newConversation.content
  };
}

function sanitizeConversationMessages(messages: ChatMessage[], language: AppLanguage) {
  const staleRuntimeStatuses = new Set(["queued", "accepted", "model-selected"]);
  const staleRuntimeMessage = language === "zh"
    ? "上一版本只记录了运行队列确认，请重新发送这条任务。"
    : "A previous version only stored the runtime queue acknowledgement. Please send this task again.";
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const content = String(message.content || "").trim().toLowerCase();
    if (!staleRuntimeStatuses.has(content)) return message;
    return {
      ...message,
      content: staleRuntimeMessage
    };
  });
}

function normalizeTaskBoardList(value: unknown): TaskBoardPlan[] {
  return normalizeRegistryTaskBoardPlans(value);
}

function activeTaskBoardForSession(session: ConversationSession | null | undefined) {
  const boards = normalizeTaskBoardList(session?.taskBoards || []);
  if (boards.length === 0) return null;
  return boards.find((board) => board.id === session?.activeTaskBoardId) || boards.at(-1) || null;
}

function projectIdFromWorkspace(workspacePath: string) {
  const normalized = workspacePath.trim().replace(/[\\/]+$/, "");
  return normalized || "no-workspace";
}

function projectNameFromWorkspace(workspacePath: string, language: AppLanguage) {
  const projectId = projectIdFromWorkspace(workspacePath);
  if (projectId === "no-workspace") {
    return uiCopy[language].history.noProject;
  }
  return projectId.split(/[\\/]/).filter(Boolean).pop() || projectId;
}

function createConversationSession(
  workspacePath: string,
  language: AppLanguage,
  messages: ChatMessage[] = [createNewConversationMessage(language)]
): ConversationSession {
  const now = new Date().toISOString();
  const projectId = projectIdFromWorkspace(workspacePath);
  const projectName = projectNameFromWorkspace(workspacePath, language);
  return {
    id: createId(),
    projectId,
    projectName,
    workspacePath,
    title: uiCopy[language].history.untitled,
    createdAt: now,
    updatedAt: now,
    messages,
    contextAnchors: [],
    taskBoards: []
  };
}

function sortConversationStore(store: ConversationStore): ConversationStore {
  const projects = store.projects
    .map((project) => ({
      ...project,
      sessions: [...project.sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    }))
    .filter((project) => project.sessions.length > 0)
    .sort((a, b) => {
      const aTime = Date.parse(a.sessions[0]?.updatedAt || "");
      const bTime = Date.parse(b.sessions[0]?.updatedAt || "");
      return bTime - aTime;
    });

  return { ...store, projects };
}

function findConversationSession(store: ConversationStore, sessionId: string) {
  for (const project of store.projects) {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (session) return session;
  }
  return null;
}

function upsertConversationSession(
  store: ConversationStore,
  session: ConversationSession,
  language: AppLanguage,
  makeActive = true
): ConversationStore {
  const projectId = projectIdFromWorkspace(session.workspacePath);
  const projectName = projectNameFromWorkspace(session.workspacePath, language);
  const normalizedSession: ConversationSession = {
    ...session,
    projectId,
    projectName,
    title: session.title || uiCopy[language].history.untitled
  };
  const projects = store.projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((candidate) => candidate.id !== session.id)
    }))
    .filter((project) => project.sessions.length > 0 || project.id === projectId);

  const existingProject = projects.find((project) => project.id === projectId);
  if (existingProject) {
    existingProject.name = projectName;
    existingProject.workspacePath = session.workspacePath;
    existingProject.sessions = [normalizedSession, ...existingProject.sessions];
  } else {
    projects.push({
      id: projectId,
      name: projectName,
      workspacePath: session.workspacePath,
      sessions: [normalizedSession]
    });
  }

  return sortConversationStore({
    activeSessionId: makeActive ? normalizedSession.id : store.activeSessionId,
    projects
  });
}

function updateConversationSession(
  store: ConversationStore,
  sessionId: string,
  language: AppLanguage,
  updater: (session: ConversationSession) => ConversationSession
): ConversationStore {
  const current = findConversationSession(store, sessionId);
  if (!current) return store;
  return upsertConversationSession(store, updater(current), language, store.activeSessionId === sessionId);
}

function deleteConversationSession(store: ConversationStore, sessionId: string): ConversationStore {
  const projects = store.projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => session.id !== sessionId)
    }))
    .filter((project) => project.sessions.length > 0);
  const nextActiveSessionId = store.activeSessionId === sessionId
    ? projects[0]?.sessions[0]?.id || ""
    : store.activeSessionId;
  return sortConversationStore({ activeSessionId: nextActiveSessionId, projects });
}

function normalizeConversationStore(store: ConversationStore, settings: DesktopSettings, language: AppLanguage) {
  const sorted = sortConversationStore({
    activeSessionId: store.activeSessionId || "",
    projects: Array.isArray(store.projects)
      ? store.projects.map((project) => ({
        ...project,
        sessions: Array.isArray(project.sessions)
          ? project.sessions.map((session) => ({
            ...session,
            messages: sanitizeConversationMessages(Array.isArray(session.messages) ? session.messages : [], language),
            contextAnchors: normalizeContextAnchors(Array.isArray(session.contextAnchors) ? session.contextAnchors : []),
            taskBoards: normalizeTaskBoardList(session.taskBoards),
            activeTaskBoardId: typeof session.activeTaskBoardId === "string" ? session.activeTaskBoardId : undefined
          }))
          : []
      }))
      : []
  });
  if (findConversationSession(sorted, sorted.activeSessionId)) {
    return sorted;
  }
  const firstSession = sorted.projects[0]?.sessions[0];
  if (firstSession) {
    return { ...sorted, activeSessionId: firstSession.id };
  }
  const session = createConversationSession(settings.workspacePath, language, [createWelcomeMessage(language)]);
  return upsertConversationSession(sorted, session, language);
}

function titleFromPrompt(prompt: string, fallback: string) {
  const title = prompt.replace(/\s+/g, " ").trim();
  if (!title) return fallback;
  return title.length > 42 ? `${title.slice(0, 42)}...` : title;
}

function defaultScheduledTaskName(prompt: string, language: AppLanguage) {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!firstLine) return language === "zh" ? "定时任务" : "Scheduled task";
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}...` : firstLine;
}

function stripAnsi(value: string) {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function appendTerminalCapture(current: string, chunk: string) {
  return `${current}${chunk}`;
}

function terminalExcerpt(output: string, fallback: string) {
  const clean = stripAnsi(output);
  if (!clean) return fallback;
  return clean;
}

function conversationAgentReply(output: string, fallback: string) {
  const clean = stripAnsi(output);
  if (!clean) return fallback;
  const lines: string[] = [];
  let previousBlank = false;
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.replace(/[ \t]+$/g, "");
    const trimmed = line.trim();
    if (/^\[harness\b/i.test(trimmed)) continue;
    if (/^DeepSeek TUI Desktop/i.test(trimmed)) continue;
    if (/^Terminal is ready/i.test(trimmed)) continue;
    if (/^Runtime output/i.test(trimmed)) continue;
    if (/^Run progress/i.test(trimmed)) continue;
    if (/^终端已就绪/i.test(trimmed)) continue;
    if (/^启动后运行输出/i.test(trimmed)) continue;
    if (/^运行过程会显示/i.test(trimmed)) continue;
    if (!trimmed) {
      if (!previousBlank && lines.length > 0) lines.push("");
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    lines.push(line);
  }
  while (lines[lines.length - 1] === "") lines.pop();
  const useful = lines.join("\n").trim();
  if (!useful) return fallback;
  return useful;
}

function formatConversationRunReply(capture: RunCapture, exit: { exitCode?: number; signal?: number }, language: AppLanguage) {
  const copy = uiCopy[language].runSummary;
  const ok = !exit.signal && (exit.exitCode === 0 || typeof exit.exitCode === "undefined");
  if (!ok) return copy.failedShort;
  return conversationAgentReply(capture.output, copy.completedShort);
}

function formatRunSummary(capture: RunCapture, exit: { exitCode?: number; signal?: number }, language: AppLanguage) {
  const copy = uiCopy[language].runSummary;
  const ok = !exit.signal && (exit.exitCode === 0 || typeof exit.exitCode === "undefined");
  const status = ok ? copy.success : `${copy.failed}${typeof exit.exitCode === "number" ? ` ${exit.exitCode}` : ""}${exit.signal ? ` ${exit.signal}` : ""}`;
  return [
    `${copy.status}: ${status}`,
    `${copy.mode}: ${capture.action}`,
    `${copy.workspace}: ${capture.workspacePath || "-"}`,
    `${copy.started}: ${formatSessionTime(capture.startedAt, language)}`,
    "",
    `${copy.terminal}:`,
    terminalExcerpt(capture.output, copy.noOutput)
  ].join("\n");
}

function formatSessionTime(updatedAt: string, language: AppLanguage) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatDownloads(downloads: number, language: AppLanguage) {
  if (!downloads) return uiCopy[language].downloadsCommunity;
  if (downloads >= 1_000_000) return `${(downloads / 1_000_000).toFixed(1)}M/wk`;
  if (downloads >= 1_000) return `${Math.round(downloads / 1_000)}K/wk`;
  return `${downloads}/wk`;
}

function iconForSkill(skill: SkillPreset) {
  if (skill.icon === "palette") return Palette;
  if (skill.icon === "calendar") return CalendarClock;
  if (skill.icon === "download") return DownloadCloud;
  return Zap;
}

function iconForMcp(id: string) {
  if (id === "github") return Github;
  if (id === "filesystem") return HardDrive;
  if (id === "postgres" || id === "stripe") return Database;
  if (id === "playwright" || id === "puppeteer") return Globe2;
  if (id === "context7" || id === "sequential-thinking" || id === "memory") return Brain;
  if (id === "pannel" || id === "mcp-remote") return Server;
  return Plug;
}

function runtimeItemRequestId(item: RuntimeApiItemRecord) {
  return String(item.metadata?.request_id || item.metadata?.approval_id || "");
}

function runtimeItemTitle(item: RuntimeApiItemRecord) {
  if (item.kind === "approval_request") return "Approval";
  if (item.kind === "user_input_request") return "Question";
  if (item.kind === "tool_call") return "Tool";
  if (item.kind === "context_compaction") return "Compaction";
  if (item.kind === "error") return "Error";
  if (item.kind === "status") return "Status";
  return "";
}

function runtimeTimelineTitle(entry: RuntimeTimelineEntry, language: AppLanguage) {
  if (entry.kind === "finalAnswer") return language === "zh" ? "最终回复" : "Final answer";
  if (entry.kind === "question") return language === "zh" ? "需要确认" : "Question";
  if (entry.kind === "approval") return language === "zh" ? "需要批准" : "Approval";
  if (entry.kind === "error") return language === "zh" ? "错误" : "Error";
  if (entry.kind === "action") return language === "zh" ? "执行动作" : "Action";
  if (entry.kind === "toolCall") return language === "zh" ? "工具调用" : "Tool call";
  return runtimeItemTitle(entry.item as RuntimeApiItemRecord);
}

function runtimeThreadEventOutputChunk(event: RuntimeApiThreadEventRecord) {
  if (event.event === "item.delta") {
    return String(event.payload?.delta || "");
  }
  if (event.event === "item.completed" || event.event === "item.failed" || event.event === "item.interrupted") {
    const item = event.payload?.item;
    const kind = String(item?.kind || "");
    if (kind === "status" || kind === "error") {
      return `${String(item?.detail || item?.summary || "")}\n`;
    }
  }
  if (event.event === "approval.required") {
    return `${String(event.payload?.description || "Approval required")}\n`;
  }
  if (event.event === "user_input.required") {
    const question = event.payload?.request?.questions?.[0]?.question;
    return `${String(question || "User input required")}\n`;
  }
  return "";
}

function runtimeContextTurnStatusLabel(status: string, language: AppLanguage) {
  if (status === "waiting_user_input") {
    return uiCopy[language].runtimeContext.waiting;
  }
  if (status === "in_progress") {
    return uiCopy[language].runtimeContext.running;
  }
  if (status === "completed") {
    return uiCopy[language].runtimeContext.completed;
  }
  return status;
}

function interactionPhaseLabel(state: InteractionState, language: AppLanguage) {
  const zh: Record<InteractionPhase, string> = {
    ready: "可发送",
    routing: "正在路由",
    queued: "已排队",
    running: "正在执行",
    streaming: "正在输出",
    waiting_user_input: "等待你的选择",
    waiting_approval: "等待批准",
    blocked: "需要配置",
    completed: "已完成",
    failed: "运行失败",
    cancelled: "已取消",
    stale_running: "暂无新输出"
  };
  const en: Record<InteractionPhase, string> = {
    ready: "Ready",
    routing: "Routing",
    queued: "Queued",
    running: "Running",
    streaming: "Streaming",
    waiting_user_input: "Waiting for input",
    waiting_approval: "Waiting for approval",
    blocked: "Setup needed",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    stale_running: "No recent output"
  };
  return (language === "zh" ? zh : en)[state.phase];
}

function interactionDetailText(state: InteractionState, language: AppLanguage) {
  if (state.reason === "missing_api_key") {
    return language === "zh" ? "先在设置里填入 API Key" : "Add an API key in settings first";
  }
  if (state.reason === "missing_workspace") {
    return language === "zh" ? "先选择本次任务要操作的 workspace" : "Choose a workspace for this task first";
  }
  if (state.reason === "routing_runtime") {
    return language === "zh" ? "正在选择 Skill、模型和运行配置" : "Selecting skills, model, and runtime settings";
  }
  if (state.reason === "turn_queued") {
    return language === "zh" ? "任务已进入队列，稍后开始执行" : "The task is queued and will start shortly";
  }
  if (state.reason === "streaming_output") {
    return language === "zh" ? "运行时仍在输出，结果会持续追加" : "Runtime output is still streaming";
  }
  if (state.reason === "runtime_running") {
    return language === "zh" ? "长任务正在执行，可以随时停止" : "The long task is running and can be stopped";
  }
  if (state.reason === "running_without_recent_output") {
    return language === "zh" ? "任务仍处于运行态，但最近没有新的输出" : "The task is still running, but no new output has arrived recently";
  }
  if (state.reason === "waiting_user_input") {
    return language === "zh" ? "请先回答运行时提出的问题" : "Answer the runtime question before sending another prompt";
  }
  if (state.reason === "waiting_approval") {
    return language === "zh" ? "请先允许或拒绝待处理动作" : "Allow or deny the pending action before continuing";
  }
  if (state.reason === "runtime_api_unavailable") {
    return state.detail || (language === "zh" ? "Runtime API 暂不可用" : "Runtime API is unavailable");
  }
  if (state.reason === "runtime_failed") {
    return state.detail || (language === "zh" ? "可以修正输入后重试" : "You can adjust the prompt and retry");
  }
  if (state.capabilityIssue) {
    const issue = state.capabilityIssue;
    return language === "zh"
      ? `已选择的 ${issue.id} 当前不可调用：${issue.reason || issue.state}`
      : `Selected ${issue.id} is not callable: ${issue.reason || issue.state}`;
  }
  if (state.reason === "runtime_completed") {
    return language === "zh" ? "可以继续发送下一步" : "You can send the next step";
  }
  if (state.reason === "runtime_cancelled") {
    return language === "zh" ? "本轮已停止，可以重新发送" : "This turn stopped. You can send again";
  }
  return language === "zh" ? "准备接收下一条任务" : "Ready for the next task";
}

function App() {
  const [settings, setSettings] = useState<DesktopSettings>(defaultSettings);
  const [runtime, setRuntime] = useState<RuntimeCheck | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeSnapshot>(() => createEmptyRuntimeSnapshot());
  const [runtimeOrchestratorSnapshot, setRuntimeOrchestratorSnapshot] = useState<RuntimeOrchestratorSnapshot>(() => createEmptyRuntimeOrchestratorSnapshot());
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [runtimeApiStatus, setRuntimeApiStatus] = useState<RuntimeApiStatus | null>(null);
  const [runtimeApiInfo, setRuntimeApiInfo] = useState<RuntimeApiInfo | null>(null);
  const [runtimeApiSkills, setRuntimeApiSkills] = useState<RuntimeApiSkill[]>([]);
  const [runtimeApiMcpServers, setRuntimeApiMcpServers] = useState<RuntimeApiMcpServer[]>([]);
  const [runtimeApiLoading, setRuntimeApiLoading] = useState(false);
  const [runtimeApiMessage, setRuntimeApiMessage] = useState("");
  const [runtimeThreadDetails, setRuntimeThreadDetails] = useState<Record<string, RuntimeApiThreadDetail>>({});
  const [runtimeUserInputDrafts, setRuntimeUserInputDrafts] = useState<Record<string, Record<string, string>>>({});
  const [remoteStatus, setRemoteStatus] = useState<RemoteBridgeStatus | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<StatusState>({ type: "ready" });
  const [remoteMessage, setRemoteMessage] = useState("");
  const [loginAccount, setLoginAccount] = useState("");
  const [loginDisplayName, setLoginDisplayName] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [inspectorPanel, setInspectorPanel] = useState<InspectorPanel>(null);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [toolPage, setToolPage] = useState<ToolPage>("overview");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("agent");
  const [mcpSearch, setMcpSearch] = useState("");
  const [mcpCategory, setMcpCategory] = useState<"All" | McpPreset["category"]>("All");
  const [customization, setCustomization] = useState<CustomizationDraft | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDescription, setNewSkillDescription] = useState("");
  const [mcpDraft, setMcpDraft] = useState("");
  const [customMcpId, setCustomMcpId] = useState("");
  const [customMcpCommand, setCustomMcpCommand] = useState("npx");
  const [customMcpArgs, setCustomMcpArgs] = useState("");
  const [customMcpUrl, setCustomMcpUrl] = useState("");
  const [customMcpEnv, setCustomMcpEnv] = useState("{}");
  const [templateMessage, setTemplateMessage] = useState("");
  const [mcpTestResult, setMcpTestResult] = useState<McpTestResult | null>(null);
  const mcpTestServers = mcpTestResult?.servers ?? null;
  const [mcpTesting, setMcpTesting] = useState(false);
  const [mcpSecretTarget, setMcpSecretTarget] = useState<McpSecretTarget | null>(null);
  const [mcpSecretValue, setMcpSecretValue] = useState("");
  const [mcpSecretSaving, setMcpSecretSaving] = useState(false);
  const [automationTasks, setAutomationTasks] = useState<AutomationTask[]>([]);
  const [automationDraft, setAutomationDraft] = useState<AutomationDraft>(() => createAutomationDraft(defaultSettings));
  const [automationMessage, setAutomationMessage] = useState("");
  const [automationMessageKind, setAutomationMessageKind] = useState<"info" | "error">("info");
  const [automationBusy, setAutomationBusy] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [gitMessage, setGitMessage] = useState("");
  const [gitMessageKind, setGitMessageKind] = useState<"info" | "error">("info");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitDiffSummary, setGitDiffSummary] = useState("");
  const [gitDiffBusy, setGitDiffBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [createWelcomeMessage(defaultSettings.language)]);
  const [lastSkillRoute, setLastSkillRoute] = useState<SkillRouteDecision | null>(null);
  const [lastModelRoute, setLastModelRoute] = useState<ModelRouteDecision | null>(null);
  const [taskBoardBusy, setTaskBoardBusy] = useState(false);
  const [taskBoardMessage, setTaskBoardMessage] = useState("");
  const [taskBoardFallbackPrompt, setTaskBoardFallbackPrompt] = useState("");
  const [desktopHookEvents, setDesktopHookEvents] = useState<DesktopHookEvent[]>([]);
  const [interactionNow, setInteractionNow] = useState(() => Date.now());
  const [conversationStore, setConversationStore] = useState<ConversationStore>({ activeSessionId: "", projects: [] });
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const historyScrollRef = useRef<HTMLElement | null>(null);
  const mcpSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [historyScrollState, setHistoryScrollState] = useState({ canScrollUp: false, canScrollDown: false });
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeSessionIdRef = useRef("");
  const terminalRunSessionIdRef = useRef("");
  const terminalRawOutputBySessionRef = useRef<Record<string, string>>({});
  const terminalOutputBySessionRef = useRef<Record<string, string>>({});
  const runCaptureRef = useRef<RunCapture | null>(null);
  const runtimeAgentSignatureRef = useRef("");
  const conversationStoreRef = useRef<ConversationStore>({ activeSessionId: "", projects: [] });
  const desktop = useMemo(() => getDesktopBridge(), []);
  const language = settings.language;
  const t = uiCopy[language];
  const selectedModelPreset = useMemo(
    () => settings.provider === "deepseek" ? modelPresetForValue(settings.model) : null,
    [settings.model, settings.provider]
  );
  const deepSeekEndpointMode = useMemo(
    () => deepSeekEndpointModeForBaseUrl(settings.baseUrl),
    [settings.baseUrl]
  );
  const selectedModelApiName = apiModelForProvider(settings.provider, settings.model);
  const selectedModelDocsLabel = selectedModelPreset
    ? (language === "zh" ? selectedModelPreset.docsLabelZh : selectedModelPreset.docsLabelEn)
    : "";
  const hasGlobalApiKey = Boolean(apiKey.trim());
  const statusText = useMemo(() => formatStatus(status, language), [language, status]);
  const activeSession = useMemo(
    () => findConversationSession(conversationStore, conversationStore.activeSessionId),
    [conversationStore]
  );
  const activeTaskBoard = useMemo(
    () => activeTaskBoardForSession(activeSession),
    [activeSession]
  );
  const activeRuntimeThreadDetail = useMemo(
    () => activeSession?.runtimeThreadId ? runtimeThreadDetails[activeSession.runtimeThreadId] || null : null,
    [activeSession?.runtimeThreadId, runtimeThreadDetails]
  );
  const activeRuntimeTimeline = useMemo(
    () => buildRuntimeTimeline(activeRuntimeThreadDetail) as RuntimeTimeline,
    [activeRuntimeThreadDetail]
  );
  const activeRuntimeContextHealth = useMemo(
    () => summarizeRuntimeContextHealth(activeRuntimeThreadDetail, settings.layeredContextEnabled !== false),
    [activeRuntimeThreadDetail, settings.layeredContextEnabled]
  );
  const activeSessionAnchors = useMemo(
    () => normalizeContextAnchors(activeSession?.contextAnchors || []),
    [activeSession?.contextAnchors]
  );
  const contextAnchorDraft = useMemo(
    () => selectContextAnchorDraft(agentPrompt, activeRuntimeContextHealth.latestUserPrompt, language),
    [activeRuntimeContextHealth.latestUserPrompt, agentPrompt, language]
  );
  const shouldShowRuntimeConversation = useMemo(
    () => shouldRenderRuntimeConversation(activeRuntimeThreadDetail),
    [activeRuntimeThreadDetail]
  );
  const selectedWorkspacePath = activeSession?.workspacePath || settings.workspacePath;
  const selectedWorkspaceLabel = selectedWorkspacePath.trim()
    ? projectNameFromWorkspace(selectedWorkspacePath, language)
    : t.topbar.chooseWorkspace;
  const currentBranchLabel = gitStatus?.isRepo && gitStatus.branch
    ? gitStatus.branch
    : t.topbar.noBranch;
  const processStreamEnabled = settings.processStreamEnabled !== false;
  const mcpSecretKey = mcpSecretTarget?.key || "";
  const selectedProjectId = useMemo(
    () => projectIdFromWorkspace(selectedWorkspacePath),
    [selectedWorkspacePath]
  );
  const activeSessionRuntimeTurns = useMemo(
    () => runtimeOrchestratorSnapshot.turns.filter((turn) => (
      turn.conversationId === conversationStore.activeSessionId && ACTIVE_RUNTIME_TURN_STATUSES.has(turn.status)
    )),
    [conversationStore.activeSessionId, runtimeOrchestratorSnapshot.turns]
  );
  const capabilityRecords = useMemo(
    () => buildCapabilityRecords({
      skills: runtimeApiSkills,
      mcpServers: runtimeApiMcpServers,
      settings
    }),
    [runtimeApiMcpServers, runtimeApiSkills, settings]
  );
  const capabilityContext = useMemo(
    () => buildCapabilityContext(capabilityRecords, language),
    [capabilityRecords, language]
  );
  const activeTaskBoardWithRuntimeStatus = useMemo(
    () => {
      if (!activeTaskBoard) return null;
      const runtimePlan = applyRuntimeStatusToTaskBoard(activeTaskBoard, runtimeSnapshot.agents || [], activeSessionRuntimeTurns);
      return applyTaskBoardRuntimeDetails(runtimePlan, runtimeThreadDetails);
    },
    [activeSessionRuntimeTurns, activeTaskBoard, runtimeSnapshot.agents, runtimeThreadDetails]
  );
  const activeTaskBoardSummary = useMemo(
    () => activeTaskBoardWithRuntimeStatus ? taskBoardRunSummary(activeTaskBoardWithRuntimeStatus) : null,
    [activeTaskBoardWithRuntimeStatus]
  );
  const activeRuntimeApiBusy = useMemo(
    () => activeRuntimeThreadDetail?.turns.some((turn) => ACTIVE_RUNTIME_API_TURN_STATUSES.has(turn.status)) || false,
    [activeRuntimeThreadDetail]
  );
  const activeSessionTerminalRunning = running
    && (!terminalRunSessionIdRef.current || terminalRunSessionIdRef.current === conversationStore.activeSessionId);
  const activeSessionBusy = activeSessionRuntimeTurns.length > 0 || activeRuntimeApiBusy || activeSessionTerminalRunning;
  const interactionStateBase = useMemo<DeriveInteractionStateOptions>(() => ({
    hasApiKey: hasGlobalApiKey,
    workspacePath: selectedWorkspacePath,
    statusType: status.type,
    statusMessage: status.type === "error" ? status.message : "",
    isRouting: status.type === "launching",
    activeTerminalRunning: activeSessionTerminalRunning,
    activeRuntimeTurns: activeSessionRuntimeTurns,
    runtimeApiTurns: activeRuntimeThreadDetail?.turns || [],
    runtimeItems: activeRuntimeThreadDetail?.items || [],
    runtimeSnapshot,
    runtimeApiStatus,
    runtimeEvents,
    selectedCapabilities: capabilityRecords,
    processStreamEnabled,
    nowMs: interactionNow
  }), [
    activeRuntimeThreadDetail,
    activeSessionRuntimeTurns,
    activeSessionTerminalRunning,
    capabilityRecords,
    hasGlobalApiKey,
    interactionNow,
    processStreamEnabled,
    runtimeApiStatus,
    runtimeEvents,
    runtimeSnapshot,
    selectedWorkspacePath,
    status
  ]);
  const interactionState = useMemo(
    () => deriveInteractionState({ ...interactionStateBase, prompt: agentPrompt }),
    [agentPrompt, interactionStateBase]
  );
  const composerCanSubmit = interactionState.canSubmit;
  const composerCanStop = interactionState.canStop || activeSessionBusy;
  const interactionBlocksNewPrompt = SUBMIT_BLOCKING_INTERACTION_PHASES.has(interactionState.phase);
  const activeSessionRunningReplyIds = useMemo(
    () => new Set(activeSessionRuntimeTurns.map((turn) => turn.replyMessageId).filter(Boolean)),
    [activeSessionRuntimeTurns]
  );
  const historyScrollUpLabel = language === "zh" ? "向上移动对话列表" : "Move conversation list up";
  const historyScrollDownLabel = language === "zh" ? "向下移动对话列表" : "Move conversation list down";

  const applyConversationStore = useCallback((nextStore: ConversationStore) => {
    conversationStoreRef.current = nextStore;
    setConversationStore(nextStore);
    desktop.saveConversationHistory(nextStore).catch(() => undefined);
    return nextStore;
  }, [desktop]);

  useEffect(() => {
    conversationStoreRef.current = conversationStore;
  }, [conversationStore]);

  const commitConversationStore = useCallback((updater: (current: ConversationStore) => ConversationStore) => {
    setConversationStore((current) => {
      const nextStore = updater(current);
      conversationStoreRef.current = nextStore;
      desktop.saveConversationHistory(nextStore).catch(() => undefined);
      return nextStore;
    });
  }, [desktop]);

  useEffect(() => {
    activeSessionIdRef.current = conversationStore.activeSessionId;
  }, [conversationStore.activeSessionId]);

  useEffect(() => {
    setInteractionNow(Date.now());
    if (!activeSessionBusy && runtimeSnapshot.status !== "running" && status.type !== "launching") return undefined;
    const timer = window.setInterval(() => setInteractionNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [activeSessionBusy, runtimeSnapshot.status, status.type]);

  const updateHistoryScrollState = useCallback(() => {
    const node = historyScrollRef.current;
    if (!node) {
      setHistoryScrollState({ canScrollUp: false, canScrollDown: false });
      return;
    }
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    setHistoryScrollState({
      canScrollUp: node.scrollTop > 2,
      canScrollDown: node.scrollTop < maxScrollTop - 2
    });
  }, []);

  const scrollHistory = useCallback((direction: "up" | "down") => {
    const node = historyScrollRef.current;
    if (!node) return;
    const historyScrollStep = Math.max(160, Math.round(node.clientHeight * 0.72));
    node.scrollBy({
      top: direction === "up" ? -historyScrollStep : historyScrollStep,
      behavior: "smooth"
    });
    window.setTimeout(updateHistoryScrollState, 180);
  }, [updateHistoryScrollState]);

  useEffect(() => {
    updateHistoryScrollState();
  }, [conversationStore.projects, expandedProjectIds, updateHistoryScrollState]);

  useEffect(() => {
    updateHistoryScrollState();
    window.addEventListener("resize", updateHistoryScrollState);
    return () => window.removeEventListener("resize", updateHistoryScrollState);
  }, [updateHistoryScrollState]);

  useEffect(() => {
    if (!activeSession?.projectId) return;
    setExpandedProjectIds((current) => {
      if (current.size === 1 && current.has(activeSession.projectId)) return current;
      return new Set([activeSession.projectId]);
    });
  }, [activeSession?.projectId]);

  useEffect(() => {
    let active = true;
    desktop.getRuntimeSnapshot().then((snapshot) => {
      if (!active) return;
      setRuntimeSnapshot(snapshot);
      setRuntimeEvents(snapshot.events || []);
    }).catch(() => {
      // Older preview bridges may not expose runtime state during hot reload.
    });
	    const offSnapshot = desktop.onRuntimeSnapshot((snapshot) => {
	      setRuntimeSnapshot(snapshot);
	      setRuntimeEvents(snapshot.events || []);
	      const agentSignature = (snapshot.agents || []).map((agent) => `${agent.id}:${agent.status}:${agent.type || ""}`).join("|");
	      if (agentSignature && agentSignature !== runtimeAgentSignatureRef.current) {
	        runtimeAgentSignatureRef.current = agentSignature;
	        setDesktopHookEvents((events) => appendDesktopHookEvent(events, "afterAgentStateChange", "Agent state changed", {
	          agents: snapshot.agents
	        }));
	      }
	    });
    const offEvent = desktop.onRuntimeEvent((event) => {
      setRuntimeEvents((current) => [...current, event].slice(-80));
    });
    return () => {
      active = false;
      offSnapshot();
      offEvent();
    };
  }, [desktop]);

  const appendProcessStreamForSession = useCallback((sessionId: string, chunk: string) => {
    if (!sessionId || !chunk) return "";
    const raw = appendTerminalCapture(terminalRawOutputBySessionRef.current[sessionId] || "", chunk);
    terminalRawOutputBySessionRef.current[sessionId] = raw;
    const output = formatProcessStreamOutput(raw);
    terminalOutputBySessionRef.current[sessionId] = output;
    return output;
  }, []);

  const renderTerminalForSession = useCallback((sessionId?: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.clear();
    const output = sessionId
      ? terminalOutputBySessionRef.current[sessionId] || ""
      : "";
    if (output) {
      terminal.write(output);
      return;
    }
    terminal.write(t.terminal.bootReady);
    terminal.write(t.terminal.bootHint);
  }, [t]);

  useEffect(() => {
    let active = true;
    desktop.getRuntimeOrchestratorSnapshot().then((snapshot) => {
      if (active) setRuntimeOrchestratorSnapshot(snapshot);
    }).catch(() => {
      // Older preview bridges may not expose the app-server runtime during hot reload.
    });
    const offSnapshot = desktop.onRuntimeOrchestratorSnapshot((snapshot) => {
      setRuntimeOrchestratorSnapshot(snapshot);
    });
    const offTurn = desktop.onRuntimeTurnEvent((event) => {
      if (!event?.type && !event?.event) return;
      const eventType = event.type || event.event || "";
      const sessionId = event.conversationId || "";
      const chunk = runtimeTurnOutputChunk(event);
      if (sessionId && chunk) {
        appendProcessStreamForSession(sessionId, chunk);
        if (activeSessionIdRef.current === sessionId) {
          renderTerminalForSession(sessionId);
        }
      }
      if (eventType === "turn-started") {
        if (!sessionId || activeSessionIdRef.current === sessionId) {
          setStatus({ type: "running" });
        }
      }
      if (eventType === "turn-completed" || eventType === "turn-failed" || eventType === "turn-cancelled") {
        setDesktopHookEvents((events) => appendDesktopHookEvent(events, "afterTurnComplete", eventType, {
          conversationId: sessionId,
          turnId: event.turnId || "",
          status: eventType
        }));
        const replyMessageId = event.replyMessageId || "";
        if (sessionId && replyMessageId) {
          const content = eventType === "turn-completed"
            ? (event.output || t.runSummary.completedShort)
            : eventType === "turn-cancelled"
              ? t.status.stopped
              : (event.error || t.runSummary.failedShort);
          const message: ChatMessage = {
            id: replyMessageId,
            role: "assistant",
            title: t.runSummary.title,
            content
          };
          commitConversationStore((current) => updateConversationSession(current, sessionId, language, (session) => ({
            ...session,
            runtimeThreadId: event.threadId || session.runtimeThreadId,
            updatedAt: new Date().toISOString(),
            messages: session.messages.map((candidate) => candidate.id === replyMessageId ? message : candidate)
          })));
          if (activeSessionIdRef.current === sessionId) {
            setMessages((current) => current.map((candidate) => candidate.id === replyMessageId ? message : candidate));
          }
        }
        if (!sessionId || activeSessionIdRef.current === sessionId) {
          setStatus(
            eventType === "turn-completed"
              ? { type: "exited", exitCode: 0 }
              : eventType === "turn-cancelled"
                ? { type: "stopped" }
                : { type: "error", message: event.error || t.runSummary.failedShort }
          );
        }
      }
    });
    return () => {
      active = false;
      offSnapshot();
      offTurn();
    };
  }, [appendProcessStreamForSession, commitConversationStore, desktop, language, renderTerminalForSession, t]);

  const fitTerminal = useCallback(() => {
    const host = terminalHostRef.current;
    if (!host?.clientWidth || !host.clientHeight || !fitRef.current) {
      return;
    }
    try {
      fitRef.current.fit();
      desktop.resizeTerminal({
        cols: terminalRef.current?.cols || 120,
        rows: terminalRef.current?.rows || 34
      });
    } catch {
      // xterm can briefly report incomplete dimensions while the terminal pane is hidden.
    }
  }, [desktop]);

  const updateSetting = useCallback(<K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const refreshRuntime = useCallback(async (nextSettings?: Partial<DesktopSettings>) => {
    const result = await desktop.checkRuntime({ ...settings, ...(nextSettings || {}) });
    setRuntime(result);
    return result;
  }, [desktop, settings]);

  const loadCustomization = useCallback(async (sourceSettings: DesktopSettings = settings) => {
    const draft = await desktop.getCustomization(sourceSettings);
    setCustomization(draft);
    setMcpDraft(draft.mcpConfigText);
    return draft;
  }, [desktop, settings]);

  const loadAutomations = useCallback(async () => {
    const store = await desktop.getAutomations();
    setAutomationTasks(store.tasks || []);
    return store;
  }, [desktop]);

  const loadGitStatus = useCallback(async () => {
    const result = await desktop.getGitStatus(settings.workspacePath);
    setGitStatus(result);
    if (result.originUrl) {
      setGitRemoteUrl(result.originUrl);
    }
    if (!result.ok && result.error) {
      setGitMessage(result.error);
      setGitMessageKind("error");
    }
    return result;
  }, [desktop, settings.workspacePath]);

  useEffect(() => {
    let active = true;
    Promise.all([desktop.getSettings(), desktop.getConversationHistory(), desktop.getAutomations()]).then(([stored, storedHistory, storedAutomations]) => {
      if (!active) return;
      const merged = normalizeSettings({ ...defaultSettings, ...stored });
      const normalizedHistory = normalizeConversationStore(storedHistory, merged, merged.language);
      const session = findConversationSession(normalizedHistory, normalizedHistory.activeSessionId);
      setConversationStore(normalizedHistory);
      setAutomationTasks(storedAutomations.tasks || []);
      setAutomationDraft(createAutomationDraft(merged));
      setMessages(session?.messages.length ? session.messages : [createWelcomeMessage(merged.language)]);
      setSettings(session?.workspacePath ? { ...merged, workspacePath: session.workspacePath } : merged);
      desktop.saveConversationHistory(normalizedHistory).catch(() => undefined);
      desktop.checkRuntime(merged).then((result) => {
        if (active) setRuntime(result);
      });
      desktop.getRemoteStatus().then((result) => {
        if (active) setRemoteStatus(result);
      });
    });
    return () => {
      active = false;
    };
  }, [desktop]);

  useEffect(() => {
    let active = true;
    desktop.getApiKey(settings.provider).then((storedKey) => {
      if (active) {
        setApiKey(storedKey || "");
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktop, settings.provider]);

  useEffect(() => {
    setMessages((current) => {
      if (current.length === 1 && current[0]?.id === "welcome") {
        return [createWelcomeMessage(language)];
      }
      return current;
    });
    if (!terminalRawOutputBySessionRef.current[activeSessionIdRef.current] && !terminalOutputBySessionRef.current[activeSessionIdRef.current]) {
      renderTerminalForSession(activeSessionIdRef.current);
    }
  }, [language, renderTerminalForSession]);

  useEffect(() => {
    if (!activeSession) return;
    const nextMessages = activeSession.messages.length
      ? activeSession.messages
      : [createWelcomeMessage(language)];
    setMessages(nextMessages);
  }, [activeSession, language]);

  useEffect(() => {
    setAutomationDraft((current) => current.id || current.workspacePath ? current : {
      ...current,
      workspacePath: settings.workspacePath
    });
  }, [settings.workspacePath]);

  useEffect(() => {
    const offRemoteStatus = desktop.onRemoteStatus((nextStatus) => {
      setRemoteStatus(nextStatus);
    });
    return () => {
      offRemoteStatus();
    };
  }, [desktop]);

  useEffect(() => {
    let active = true;
    desktop.checkDesktopUpdate({ silent: true }).then((result) => {
      if (active && result.ok && result.update) {
        setDesktopUpdate(result.update);
      }
    }).catch(() => undefined);
    const offDesktopUpdate = desktop.onDesktopUpdateAvailable((update) => {
      setDesktopUpdate(update);
    });
    return () => {
      active = false;
      offDesktopUpdate();
    };
  }, [desktop]);

  useEffect(() => {
    if (mainView === "tools" && (toolPage === "skills" || toolPage === "mcp")) {
      loadCustomization().catch(() => undefined);
    }
  }, [loadCustomization, mainView, toolPage]);

  useEffect(() => {
    if (mainView !== "tools" || toolPage !== "mcp") return;
    const frame = window.requestAnimationFrame(() => {
      mcpSearchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mainView, toolPage]);

  useEffect(() => {
    if (inspectorPanel === "git") {
      loadGitStatus().catch((error) => {
        setGitMessage(error instanceof Error ? error.message : t.git.actionFailed);
      });
    }
  }, [inspectorPanel, loadGitStatus, t]);

  useEffect(() => {
    if (!settings.workspacePath.trim()) {
      setGitStatus(null);
      return;
    }
    loadGitStatus().catch(() => undefined);
  }, [loadGitStatus, settings.workspacePath]);

  useEffect(() => {
    if (mainView === "tasks") {
      loadAutomations().catch((error) => {
        setAutomationMessage(error instanceof Error ? error.message : t.automations.failed);
        setAutomationMessageKind("error");
      });
    }
  }, [loadAutomations, mainView, t]);

  useEffect(() => {
    setTemplateMessage("");
    setAutomationMessage("");
    setAutomationMessageKind("info");
    setGitMessage("");
    setGitMessageKind("info");
  }, [inspectorPanel]);

  useEffect(() => {
    setTemplateMessage("");
    setAutomationMessage("");
    setAutomationMessageKind("info");
  }, [toolPage]);

  useEffect(() => {
    const account = remoteStatus?.auth.account;
    if (!account) return;
    setLoginAccount((current) => current || account.email || account.accountId);
    setLoginDisplayName((current) => current || account.displayName || "");
  }, [remoteStatus?.auth.account]);

  useEffect(() => {
    if (mainView !== "chat") {
      return;
    }

    if (mainView === "chat" && !processStreamEnabled) {
      return;
    }

    if (!terminalHostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#ffffff",
        foreground: "#1f2933",
        cursor: "#0e8f6e",
        selectionBackground: "#d7eee7",
        black: "#111827",
        red: "#b42318",
        green: "#0e8f6e",
        yellow: "#b7791f",
        blue: "#2563eb",
        magenta: "#7c3aed",
        cyan: "#0891b2",
        white: "#f8fafc",
        brightBlack: "#6b7280",
        brightRed: "#dc2626",
        brightGreen: "#059669",
        brightYellow: "#d97706",
        brightBlue: "#3b82f6",
        brightMagenta: "#9333ea",
        brightCyan: "#06b6d4",
        brightWhite: "#ffffff"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const host = terminalHostRef.current;
    terminal.open(host);
    terminal.onData((data) => desktop.sendTerminalInput(data));

    terminalRef.current = terminal;
    fitRef.current = fit;

    const resize = fitTerminal;
    const writeBootText = () => {
      resize();
      renderTerminalForSession(activeSessionIdRef.current);
    };
    window.requestAnimationFrame(writeBootText);
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      window.removeEventListener("resize", resize);
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [desktop, fitTerminal, mainView, processStreamEnabled, renderTerminalForSession]);

  useEffect(() => {
    window.requestAnimationFrame(fitTerminal);
  }, [fitTerminal, mainView]);

  useEffect(() => {
    const offData = desktop.onTerminalData((data) => {
      const capture = runCaptureRef.current;
      const terminalSessionId = capture?.sessionId || terminalRunSessionIdRef.current || activeSessionIdRef.current;
      if (terminalSessionId) {
        appendProcessStreamForSession(terminalSessionId, data);
      }
      if (capture) {
        capture.output = appendTerminalCapture(capture.output, data);
      }
      if (!terminalSessionId || activeSessionIdRef.current === terminalSessionId) {
        if (terminalSessionId) {
          renderTerminalForSession(terminalSessionId);
        }
      }
    });
    const offExit = desktop.onTerminalExit((exit) => {
      setRunning(false);
      setStatus({ type: "exited", exitCode: exit.exitCode });
      terminalRunSessionIdRef.current = "";
      const capture = runCaptureRef.current;
      runCaptureRef.current = null;
      if (capture?.sessionId) {
        const message: ChatMessage = {
          id: capture.replyMessageId || createId(),
          role: "assistant",
          title: t.runSummary.title,
          content: formatConversationRunReply(capture, exit, language)
        };
        commitConversationStore((current) => updateConversationSession(current, capture.sessionId, language, (session) => ({
          ...session,
          updatedAt: new Date().toISOString(),
          messages: capture.replyMessageId
            ? session.messages.map((candidate) => candidate.id === capture.replyMessageId ? message : candidate)
            : [...session.messages, message]
        })));
        if (activeSessionIdRef.current === capture.sessionId) {
          setMessages((current) => capture.replyMessageId
            ? current.map((candidate) => candidate.id === capture.replyMessageId ? message : candidate)
            : [...current, message]);
        }
      }
    });
    return () => {
      offData();
      offExit();
    };
  }, [appendProcessStreamForSession, commitConversationStore, desktop, language, renderTerminalForSession, t]);

  const enabledMcpCount = settings.enabledMcpServers.length;
  const enabledSkillCount = settings.enabledSkills.length;
  const skillsRuntimeReady = settings.skillsEnabled && (settings.enabledSkills.length > 0 || Boolean(settings.skillsDir.trim()));
  const scheduledTaskSkillEnabled = settings.skillsEnabled && settings.enabledSkills.includes(SCHEDULED_TASK_SKILL_ID);
  const automationGroups = useMemo(() => {
    const active: AutomationTask[] = [];
    const paused: AutomationTask[] = [];
    for (const task of automationTasks) {
      if (automationStatus(task) === "ACTIVE") {
        active.push(task);
      } else {
        paused.push(task);
      }
    }
    return [
      { key: "active", title: t.automations.activeGroup, tasks: active },
      { key: "paused", title: t.automations.pausedGroup, tasks: paused }
    ].filter((group) => group.tasks.length > 0);
  }, [automationTasks, t]);
  const skillCatalog = useMemo<SkillCatalogItem[]>(() => {
    const templates = customization?.skillTemplates || {};
    const presetMap = new Map(skillPresets.map((preset) => [preset.id, preset]));
    const ids = Array.from(new Set([...skillPresets.map((preset) => preset.id), ...Object.keys(templates)]));
    return ids.map((id) => {
      const template = templates[id];
      const preset = presetMap.get(id) || (template ? fallbackSkillPreset(template, language) : null);
      if (!preset) return null;
      const translated = getSkillText(preset, language);
      return {
        ...preset,
        name: template?.origin === "custom" ? template.name : translated.name,
        description: template?.origin === "custom" ? template.description : translated.description,
        category: template?.origin === "custom" ? t.skills.customCategory : translated.category,
        tools: template?.origin === "custom"
          ? [template.source === "file" ? t.skills.fileTag : t.skills.defaultTag]
          : preset.tools,
        path: template?.path || "",
        source: template?.source || "default",
        origin: template?.origin || "preset",
        content: template?.content || ""
      };
    }).filter((skill): skill is SkillCatalogItem => Boolean(skill));
  }, [customization, language, t]);
  const routePromptForRun = useCallback((prompt: string, mode: PermissionMode, sourceSettings: DesktopSettings = settings) => {
    setDesktopHookEvents((events) => appendDesktopHookEvent(events, "beforePromptRoute", "Prompt routing started", {
      prompt,
      mode
    }));
    const skillTemplates = Object.fromEntries(skillCatalog.map((skill) => [skill.id, skill]));
    const skillRoute = routeSkillsForPrompt({
      prompt,
      workspacePath: sourceSettings.workspacePath,
      settings: sourceSettings,
      skillTemplates
    });
    const modelRoute = routeModelForPrompt({
      prompt: skillRoute.sanitizedPrompt || prompt,
      permissionMode: mode,
      settings: sourceSettings,
      activeSkillIds: skillRoute.activeSkillIds,
      routeIntents: skillRoute.intents
    });
    setLastSkillRoute(skillRoute);
    setLastModelRoute(modelRoute);
    setDesktopHookEvents((events) => appendDesktopHookEvent(events, "afterSkillRoute", "Skill route resolved", {
      activeSkillIds: skillRoute.activeSkillIds,
      intents: skillRoute.intents.map((intent) => intent.id),
      model: modelRoute.apiModel,
      routeDebug: skillRoute.routeDebug.summary
    }));
    return {
      skillRoute,
      modelRoute,
      prompt: skillRoute.sanitizedPrompt || prompt,
      runtimeSettings: {
        ...sourceSettings,
        enabledSkills: skillRoute.activeSkillIds,
        model: modelRoute.apiModel,
        provider: modelRoute.provider
      }
    };
  }, [settings, skillCatalog]);
  const mcpCategories = useMemo(() => {
    return ["All", ...Array.from(new Set(mcpPresets.map((preset) => preset.category)))] as Array<"All" | McpPreset["category"]>;
  }, []);
  const filteredMcpPresets = useMemo(() => {
    const query = mcpSearch.trim().toLowerCase();
    return mcpPresets.filter((preset) => {
      const text = getMcpText(preset, language);
      const matchesCategory = mcpCategory === "All" || preset.category === mcpCategory;
      const matchesQuery = !query || [
        preset.name,
        preset.description,
        preset.source,
        preset.command,
        text.name,
        text.description,
        text.envHint
      ].join(" ").toLowerCase().includes(query);
      return matchesCategory && matchesQuery;
    });
  }, [language, mcpCategory, mcpSearch]);
  const selectedMcpPresets = useMemo(() => {
    return mcpPresets.filter((preset) => settings.enabledMcpServers.includes(preset.id));
  }, [settings.enabledMcpServers]);
  const mcpAdapterRows = useMemo<McpAdapterRow[]>(() => {
    const testById = new Map((mcpTestResult?.servers || []).map((server) => [server.id, server]));
    const rows: McpAdapterRow[] = selectedMcpPresets.map((preset) => {
      const text = getMcpText(preset, language);
      const server = testById.get(preset.id);
      const guide = mcpGuideForPreset(preset, language);
      const envKeys = Array.from(new Set([...(server?.missingEnv || []), ...mcpEnvKeysFromHint(text.envHint)]));
      const envKey = envKeys[0] || "";
      const status: McpAdapterRow["status"] = server?.status || "untested";
      const statusMap: Record<McpAdapterRow["status"], string> = {
        ready: t.mcp.ready,
        "needs-auth": t.mcp.needsAuth,
        "needs-config": t.mcp.needsConfig,
        "command-missing": t.mcp.commandMissing,
        "invalid-url": t.mcp.invalidUrl,
        untested: t.mcp.untested
      };
      return {
        id: preset.id,
        name: text.name,
        description: text.description,
        envKey,
        envKeys,
        guideUrl: guide.url,
        guideLabel: guide.label,
        guideActionLabel: mcpGuideActionLabel(preset, language),
        auth: preset.auth,
        status,
        statusText: statusMap[status],
        hint: server?.warnings?.[0] || (envKey ? text.envHint : text.description),
        injectable: Boolean(server?.injectable),
        warnings: server?.warnings || [],
        command: server ? [server.command, ...server.args].filter(Boolean).join(" ") : preset.command
      };
    });
    for (const server of mcpTestResult?.servers || []) {
      if (selectedMcpPresets.some((preset) => preset.id === server.id)) continue;
      const status: McpAdapterRow["status"] = server.status || "untested";
      const statusMap: Record<McpAdapterRow["status"], string> = {
        ready: t.mcp.ready,
        "needs-auth": t.mcp.needsAuth,
        "needs-config": t.mcp.needsConfig,
        "command-missing": t.mcp.commandMissing,
        "invalid-url": t.mcp.invalidUrl,
        untested: t.mcp.untested
      };
      rows.push({
        id: server.id,
        name: server.id,
        description: server.url ? server.url : [server.command, ...server.args].filter(Boolean).join(" "),
        envKey: server.missingEnv?.[0] || "",
        envKeys: server.missingEnv || [],
        guideUrl: "",
        guideLabel: "",
        guideActionLabel: t.mcp.openGuide,
        auth: "Connection",
        status,
        statusText: statusMap[status],
        hint: server.warnings?.[0] || "",
        injectable: Boolean(server.injectable),
        warnings: server.warnings || [],
        command: server.url || [server.command, ...server.args].filter(Boolean).join(" ")
      });
    }
    return rows;
  }, [language, mcpTestResult, selectedMcpPresets, t]);
  const mcpSetupRows = useMemo(() => mcpAdapterRows, [mcpAdapterRows]);
  const mcpInjectableCount = mcpAdapterRows.filter((row) => row.injectable).length;
  const mcpRuntimeReady = settings.mcpEnabled && mcpInjectableCount > 0;

  const saveSettings = useCallback(async () => {
    if (apiKey.trim()) {
      const keyResult = await desktop.saveApiKey({ provider: settings.provider, apiKey });
      if (!keyResult.ok) {
        setStatus({ type: "error", message: keyResult.error || t.settings.apiKeySaveFailed });
        return;
      }
    }
    const nextSettings = normalizeSettings(settings);
    const saved = await desktop.saveSettings(nextSettings);
    setSettings(saved);
    setRemoteStatus(await desktop.getRemoteStatus());
    await loadCustomization(saved);
    await refreshRuntime(saved);
    setStatus({ type: "settingsSaved" });
    setRemoteMessage(t.remote.saved);
  }, [apiKey, desktop, loadCustomization, refreshRuntime, settings, t]);

  const switchLanguage = useCallback(async (nextLanguage: AppLanguage) => {
    if (nextLanguage === language) return;
    const nextSettings = { ...settings, language: nextLanguage };
    setSettings(nextSettings);
    const saved = await desktop.saveSettings(nextSettings);
    setSettings(saved);
    setRemoteStatus(await desktop.getRemoteStatus());
    setStatus({ type: "languageSaved" });
    setRemoteMessage(uiCopy[nextLanguage].status.languageSaved);
  }, [desktop, language, settings]);

  const chooseWorkspace = useCallback(async () => {
    const selected = await desktop.chooseDirectory();
    if (selected) {
      const nextSettings = normalizeSettings({ ...settings, workspacePath: selected });
      setSettings(nextSettings);
      setAutomationDraft((current) => current.id ? current : { ...current, workspacePath: selected });
      const selectedProjectId = projectIdFromWorkspace(selected);
      const selectedProject = conversationStore.projects.find((project) => project.id === selectedProjectId);
      const currentSession = findConversationSession(conversationStore, conversationStore.activeSessionId);
      const isEmptySession = currentSession
        && currentSession.title === uiCopy[language].history.untitled
        && currentSession.messages.every((message) => message.role === "assistant");
      let nextSession = selectedProject?.sessions[0] || null;
      let nextStore = nextSession
        ? { ...conversationStore, activeSessionId: nextSession.id }
        : conversationStore;

      if (!nextSession && currentSession && isEmptySession) {
        nextSession = {
          ...currentSession,
          workspacePath: selected,
          updatedAt: new Date().toISOString()
        };
        terminalRawOutputBySessionRef.current[nextSession.id] = "";
        terminalOutputBySessionRef.current[nextSession.id] = "";
        nextStore = upsertConversationSession(conversationStore, nextSession, language);
      }

      if (!nextSession) {
        nextSession = createConversationSession(selected, language, [createNewConversationMessage(language)]);
        nextStore = upsertConversationSession(conversationStore, nextSession, language);
      }

      applyConversationStore(nextStore);
      activeSessionIdRef.current = nextSession.id;
      setExpandedProjectIds(() => new Set([projectIdFromWorkspace(nextSession.workspacePath)]));
      setMessages(nextSession.messages.length ? nextSession.messages : [createNewConversationMessage(language)]);
      renderTerminalForSession(nextSession.id);
      setAgentPrompt("");
      setMainView("chat");
      const saved = await desktop.saveSettings(nextSettings);
      setSettings(saved);
      await refreshRuntime(saved);
      setStatus({ type: "settingsSaved" });
    }
  }, [applyConversationStore, conversationStore, desktop, language, refreshRuntime, renderTerminalForSession, settings]);

  const openWorkspaceEditor = useCallback(async (editor: WorkspaceEditor) => {
    const workspacePath = settings.workspacePath.trim();
    if (!workspacePath) {
      setStatus({ type: "error", message: t.topbar.noWorkspace });
      return;
    }

    const result = await desktop.openWorkspaceEditor({ editor, workspacePath });
    if (result.ok) {
      setStatus({ type: "editorOpened", editor: editor === "vscode" ? "VS Code" : "Cursor" });
      return;
    }

    setStatus({ type: "error", message: result.error || t.status.launchFailed });
  }, [desktop, settings.workspacePath, t]);

  const chooseCustomBinary = useCallback(async () => {
    const selected = await desktop.chooseFile();
    if (selected) {
      updateSetting("customBinaryPath", selected);
      updateSetting("binaryMode", "custom");
      await refreshRuntime({ customBinaryPath: selected, binaryMode: "custom" });
    }
  }, [desktop, refreshRuntime, updateSetting]);

  const chooseMcpConfig = useCallback(async () => {
    const selected = await desktop.chooseFile([
      { name: "MCP JSON", extensions: ["json"] }
    ]);
    if (selected) {
      updateSetting("mcpConfigPath", selected);
    }
  }, [desktop, updateSetting]);

  const chooseSkillsDir = useCallback(async () => {
    const selected = await desktop.chooseDirectory();
    if (selected) {
      updateSetting("skillsDir", selected);
    }
  }, [desktop, updateSetting]);

  const chooseAutomationWorkspace = useCallback(async () => {
    const selected = await desktop.chooseDirectory();
    if (selected) {
      setAutomationDraft((current) => ({ ...current, workspacePath: selected }));
    }
  }, [desktop]);

  const newAutomationDraft = useCallback(() => {
    setAutomationDraft(createAutomationDraft(settings));
    setAutomationMessage("");
    setAutomationMessageKind("info");
  }, [settings]);

  const selectAutomationTask = useCallback((task: AutomationTask) => {
    setAutomationDraft(createAutomationDraft(settings, task));
    setAutomationMessage("");
    setAutomationMessageKind("info");
  }, [settings]);

  const applyAutomationResult = useCallback((result: AutomationActionResult, successMessage: string) => {
    setAutomationTasks(result.tasks || []);
    setAutomationMessage(result.ok ? successMessage : result.error || t.automations.failed);
    setAutomationMessageKind(result.ok ? "info" : "error");
    if (result.task) {
      setAutomationDraft(createAutomationDraft(settings, result.task));
    }
    return result.ok;
  }, [settings, t]);

  const saveAutomationDraft = useCallback(async () => {
    setAutomationBusy(true);
    try {
      const minute = clampNumber(automationDraft.minute, 0, 59);
      const hour = clampNumber(automationDraft.hour, 0, 23);
      const name = automationDraft.name.trim() || defaultScheduledTaskName(automationDraft.prompt, language);
      const result = await desktop.saveAutomation({
        settings,
        task: {
          ...automationDraft,
          name,
          minute,
          hour,
          frequency: "daily",
          rrule: `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`,
          enabled: automationDraft.status === "ACTIVE"
        }
      });
      applyAutomationResult(result, t.automations.saved);
    } finally {
      setAutomationBusy(false);
    }
  }, [applyAutomationResult, automationDraft, desktop, language, settings, t]);

  const installAutomationTask = useCallback(async (task: AutomationTask) => {
    setAutomationBusy(true);
    try {
      const result = await desktop.installAutomation({ id: task.id, settings });
      applyAutomationResult(result, t.automations.installedOk);
    } finally {
      setAutomationBusy(false);
    }
  }, [applyAutomationResult, desktop, settings, t]);

  const uninstallAutomationTask = useCallback(async (task: AutomationTask) => {
    setAutomationBusy(true);
    try {
      const result = await desktop.uninstallAutomation({ id: task.id, settings });
      applyAutomationResult(result, t.automations.uninstalledOk);
    } finally {
      setAutomationBusy(false);
    }
  }, [applyAutomationResult, desktop, settings, t]);

  const deleteAutomationTask = useCallback(async (task: AutomationTask) => {
    if (!window.confirm(t.automations.confirmDelete)) {
      return;
    }
    setAutomationBusy(true);
    try {
      const result = await desktop.deleteAutomation({ id: task.id });
      if (applyAutomationResult(result, t.automations.deletedOk)) {
        setAutomationDraft(createAutomationDraft(settings));
      }
    } finally {
      setAutomationBusy(false);
    }
  }, [applyAutomationResult, desktop, settings, t]);

  const updateProvider = useCallback((provider: ProviderMode) => {
    setSettings((current) => ({
      ...current,
      provider,
      baseUrl: defaultBaseUrlForProvider(provider),
      model: provider === "deepseek"
        ? normalizeDeepSeekModelSelection(current.model)
        : current.model || DEFAULT_DEEPSEEK_MODEL
    }));
  }, []);

  const updateModel = useCallback((model: string) => {
    setSettings((current) => ({
      ...current,
      model,
      baseUrl: current.baseUrl || defaultBaseUrlForProvider(current.provider)
    }));
  }, []);

  const updateDeepSeekEndpointMode = useCallback((mode: DeepSeekEndpointMode) => {
    setSettings((current) => ({
      ...current,
      baseUrl: baseUrlForDeepSeekEndpointMode(mode, current.baseUrl)
    }));
  }, []);

  const refreshRuntimeApi = useCallback(async () => {
    setRuntimeApiLoading(true);
    setRuntimeApiMessage("");
    try {
      const statusResult = await desktop.getRuntimeApiStatus(settings);
      setRuntimeApiStatus(statusResult);
      if (statusResult.info) {
        setRuntimeApiInfo(statusResult.info);
      }
      if (!statusResult.connected) {
        setRuntimeApiMessage(statusResult.error || t.runtimeApi.unavailable);
        return;
      }
      const [infoResult, skillsResult, mcpResult] = await Promise.allSettled([
        desktop.getRuntimeApiInfo(settings),
        desktop.listRuntimeApiSkills(settings),
        desktop.listRuntimeApiMcpServers(settings)
      ]);
      if (infoResult.status === "fulfilled" && infoResult.value.ok && infoResult.value.info) {
        setRuntimeApiInfo(infoResult.value.info);
      }
      if (skillsResult.status === "fulfilled" && skillsResult.value.ok) {
        setRuntimeApiSkills(skillsResult.value.skills);
      }
      if (mcpResult.status === "fulfilled" && mcpResult.value.ok) {
        setRuntimeApiMcpServers(mcpResult.value.servers);
      }
      const rejected = [infoResult, skillsResult, mcpResult].find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        setRuntimeApiMessage(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason || t.runtimeApi.unavailable));
      }
    } catch (error) {
      setRuntimeApiMessage(error instanceof Error ? error.message : String(error || t.runtimeApi.unavailable));
    } finally {
      setRuntimeApiLoading(false);
    }
  }, [desktop, settings, t]);

  const toggleRuntimeApiSkill = useCallback(async (skill: RuntimeApiSkill) => {
    const result = await desktop.setRuntimeApiSkillEnabled({
      name: skill.name || skill.id,
      enabled: !skill.enabled,
      settings
    });
    if (!result.ok) {
      setRuntimeApiMessage(result.error || t.runtimeApi.toggleFailed);
      return;
    }
    await refreshRuntimeApi();
  }, [desktop, refreshRuntimeApi, settings, t]);

  const syncRuntimeDetailAnchors = useCallback((sessionId: string, detail: RuntimeApiThreadDetail | null | undefined) => {
    if (!sessionId || !detail) return;
    const derivedTexts = deriveContextAnchorTextsFromRuntimeItems(
      orderedRuntimeConversationItems(detail) as RuntimeApiItemRecord[],
      language
    );
    if (!derivedTexts.length) return;
    const createdAt = new Date().toISOString();
    commitConversationStore((current) => updateConversationSession(current, sessionId, language, (session) => {
      const existingAnchors = normalizeContextAnchors(session.contextAnchors || []);
      const mergedAnchors = mergeDerivedContextAnchors(existingAnchors, derivedTexts, {
        createId,
        createdAt
      });
      const unchanged = mergedAnchors.length === existingAnchors.length
        && mergedAnchors.every((anchor, index) => anchor.text === existingAnchors[index]?.text);
      if (unchanged) return session;
      return {
        ...session,
        updatedAt: createdAt,
        contextAnchors: mergedAnchors
      };
    }));
  }, [commitConversationStore, language]);

  const loadRuntimeThreadDetail = useCallback(async (threadId: string) => {
    const id = threadId.trim();
    if (!id) return null;
    const result = await desktop.getRuntimeApiThread({ threadId: id, settings });
    if (result.ok && result.detail) {
      setRuntimeThreadDetails((current) => ({ ...current, [id]: result.detail! }));
      const store = conversationStoreRef.current;
      const session = store.projects.flatMap((project) => project.sessions).find((candidate) => candidate.runtimeThreadId === id);
      const sessionId = session?.id || "";
      const transcriptMessages = conversationMessagesFromRuntimeDetail(result.detail) as ChatMessage[];
      if (sessionId) {
        if (transcriptMessages.length > 0) {
          commitConversationStore((current) => updateConversationSession(current, sessionId, language, (savedSession) => ({
            ...savedSession,
            updatedAt: new Date().toISOString(),
            messages: transcriptMessages
          })));
        }
        syncRuntimeDetailAnchors(sessionId, result.detail);
      }
    }
    return result;
  }, [commitConversationStore, desktop, language, settings, syncRuntimeDetailAnchors]);

  const selectRuntimeUserInputOption = useCallback((requestId: string, questionId: string, label: string) => {
    setRuntimeUserInputDrafts((current) => ({
      ...current,
      [requestId]: {
        ...(current[requestId] || {}),
        [questionId]: label
      }
    }));
  }, []);

  const submitRuntimeUserInput = useCallback(async (item: RuntimeApiItemRecord) => {
    const threadId = activeSession?.runtimeThreadId || "";
    const requestId = String(item.metadata?.request_id || "");
    const questions = Array.isArray(item.metadata?.request?.questions) ? item.metadata.request.questions as RuntimeApiUserInputQuestion[] : [];
    const draft = runtimeUserInputDrafts[requestId] || {};
    if (!threadId || !requestId || questions.length === 0) return;
    const answers = questions
      .map((question) => {
        const label = draft[question.id];
        if (!label) return null;
        return {
          id: question.id,
          label,
          value: label
        };
      })
      .filter(Boolean) as RuntimeApiUserInputAnswer[];
    if (answers.length !== questions.length) {
      setRuntimeApiMessage(language === "zh" ? "请先完成所有问题后再继续。" : "Answer all questions before continuing.");
      return;
    }
    const result = await desktop.answerRuntimeApiUserInput({
      threadId,
      turnId: item.turn_id,
      requestId,
      answers,
      settings
    });
    if (!result.ok) {
      setRuntimeApiMessage(result.error || t.runtimeApi.unavailable);
      return;
    }
  }, [activeSession?.runtimeThreadId, desktop, language, runtimeUserInputDrafts, settings, t.runtimeApi.unavailable]);

  const decideInlineApproval = useCallback(async (item: RuntimeApiItemRecord, decision: "allow" | "deny") => {
    const approvalId = String(item.metadata?.approval_id || "");
    if (!approvalId) return;
    const result = await desktop.decideRuntimeApiApproval({
      approvalId,
      decision,
      remember: false,
      settings
    });
    if (!result.ok) {
      setRuntimeApiMessage(result.error || t.runtimeApi.unavailable);
    }
  }, [desktop, settings, t.runtimeApi.unavailable]);

  useEffect(() => {
    return desktop.onRuntimeApiStatus((nextStatus) => {
      setRuntimeApiStatus(nextStatus);
      if (nextStatus.info) {
        setRuntimeApiInfo(nextStatus.info);
      }
    });
  }, [desktop]);

  useEffect(() => {
    return desktop.onRuntimeApiThreadEvent((envelope) => {
      const threadId = envelope.threadId || envelope.detail?.thread?.id || envelope.event?.thread_id || "";
      if (!threadId || !envelope.detail) return;
      setRuntimeThreadDetails((current) => ({ ...current, [threadId]: envelope.detail }));
      const store = conversationStoreRef.current;
      const session = store.projects.flatMap((project) => project.sessions).find((candidate) => candidate.runtimeThreadId === threadId);
      const sessionId = session?.id || "";
      const chunk = envelope.event ? runtimeThreadEventOutputChunk(envelope.event) : "";
      if (sessionId && chunk) {
        appendProcessStreamForSession(sessionId, chunk);
        if (activeSessionIdRef.current === sessionId) {
          renderTerminalForSession(sessionId);
        }
      }
      const turnStatus = envelope.detail.turns.at(-1)?.status || "";
      const transcriptMessages = conversationMessagesFromRuntimeDetail(envelope.detail) as ChatMessage[];
      if (sessionId && transcriptMessages.length > 0) {
        commitConversationStore((current) => updateConversationSession(current, sessionId, language, (savedSession) => ({
          ...savedSession,
          updatedAt: new Date().toISOString(),
          messages: transcriptMessages
        })));
      }
      if (sessionId) {
        syncRuntimeDetailAnchors(sessionId, envelope.detail);
      }
	      if (activeSessionIdRef.current === sessionId) {
	        if (ACTIVE_RUNTIME_API_TURN_STATUSES.has(turnStatus as RuntimeApiTurnStatus)) {
	          setStatus({ type: "running" });
	        } else if (turnStatus === "completed") {
	          setDesktopHookEvents((events) => appendDesktopHookEvent(events, "afterTurnComplete", "Runtime API turn completed", {
	            threadId,
	            status: turnStatus
	          }));
	          setStatus({ type: "exited", exitCode: 0 });
	        } else if (turnStatus === "failed") {
	          setDesktopHookEvents((events) => appendDesktopHookEvent(events, "afterTurnComplete", "Runtime API turn failed", {
	            threadId,
	            status: turnStatus
	          }));
	          setStatus({ type: "error", message: String(envelope.detail.turns.at(-1)?.error || t.runSummary.failedShort) });
        } else if (turnStatus === "interrupted" || turnStatus === "canceled") {
          setStatus({ type: "stopped" });
        }
      }
    });
  }, [appendProcessStreamForSession, commitConversationStore, desktop, language, renderTerminalForSession, syncRuntimeDetailAnchors, t]);

  useEffect(() => {
    const threadId = activeSession?.runtimeThreadId || "";
    if (!threadId) return;
    void loadRuntimeThreadDetail(threadId);
  }, [activeSession?.runtimeThreadId, loadRuntimeThreadDetail]);

  useEffect(() => {
    if (mainView !== "tools" && inspectorPanel !== "settings") return;
    const timer = window.setTimeout(() => {
      void refreshRuntimeApi();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [inspectorPanel, mainView, refreshRuntimeApi]);

  const launch = useCallback(async (
    action?: LaunchAction,
    promptOverride?: string,
    captureSessionId?: string,
    replyMessageId?: string,
    launchOverrides: Partial<DesktopSettings> = {}
  ) => {
    fitTerminal();
    const launchAction = action || settings.launchAction;
    const prompt = (promptOverride ?? agentPrompt).trim();
    const nextSettings = normalizeSettings({
      ...settings,
      ...launchOverrides,
      launchAction
    });
    const routing = prompt
      ? routePromptForRun(prompt, launchAction === "plan" ? "plan" : launchAction === "yolo" ? "yolo" : "agent", nextSettings)
      : null;
    const effectivePrompt = routing?.prompt || prompt;
    const runtimeSettings = {
      ...(routing?.runtimeSettings || nextSettings),
      model: routing?.modelRoute.apiModel || apiModelForProvider(nextSettings.provider, nextSettings.model)
    };
    const terminalSessionId = captureSessionId || activeSessionIdRef.current;
    terminalRunSessionIdRef.current = terminalSessionId;
    if (terminalSessionId) {
      terminalRawOutputBySessionRef.current[terminalSessionId] = "";
      terminalOutputBySessionRef.current[terminalSessionId] = "";
      if (activeSessionIdRef.current === terminalSessionId) {
        renderTerminalForSession(terminalSessionId);
      }
    }
    const shouldCapture = Boolean(prompt) && (launchAction === "exec" || launchAction === "plan" || launchAction === "yolo");
    runCaptureRef.current = shouldCapture ? {
      action: launchAction,
      prompt: effectivePrompt,
      sessionId: terminalSessionId,
      replyMessageId,
      workspacePath: nextSettings.workspacePath,
      startedAt: new Date().toISOString(),
      output: ""
    } : null;

    if (nextSettings.rememberWorkspace) {
      await desktop.saveSettings(nextSettings);
    }
    const launchApiKey = apiKey.trim();
    if (launchApiKey) {
      const keyResult = await desktop.saveApiKey({ provider: nextSettings.provider, apiKey: launchApiKey });
      if (!keyResult.ok) {
        runCaptureRef.current = null;
        terminalRunSessionIdRef.current = "";
        const error = keyResult.error || t.settings.apiKeySaveFailed;
        setStatus({ type: "error", message: error });
        return { ok: false, error };
      }
    }
    setStatus({ type: "launching" });
    const result = await desktop.startTerminal({
      ...runtimeSettings,
      apiKey: launchApiKey || undefined,
      agentPrompt: effectivePrompt,
      cols: terminalRef.current?.cols,
      rows: terminalRef.current?.rows
    });
    if (!result.ok) {
      runCaptureRef.current = null;
      terminalRunSessionIdRef.current = "";
    }
    if (result.runtime) {
      setRuntime(result.runtime);
    }
    setRunning(Boolean(result.ok));
    setStatus(result.ok ? { type: "running", pid: result.pid } : { type: "error", message: result.error || t.status.launchFailed });
    return result;
  }, [agentPrompt, apiKey, desktop, fitTerminal, renderTerminalForSession, routePromptForRun, settings, t]);

  const stop = useCallback(async () => {
    let cancelledRuntimeTurn = false;
    if (activeSessionIdRef.current) {
      const result = await desktop.cancelRuntimeTurn({ conversationId: activeSessionIdRef.current });
      if (result.snapshot) {
        setRuntimeOrchestratorSnapshot(result.snapshot);
      }
      cancelledRuntimeTurn = result.cancelled > 0;
    }
    if (!cancelledRuntimeTurn && running) {
      await desktop.stopTerminal();
      setRunning(false);
      terminalRunSessionIdRef.current = "";
    }
    setStatus({ type: "stopped" });
  }, [desktop, running]);

  const toggleSkill = useCallback((id: string) => {
    setSettings((current) => {
      const enabled = new Set(current.enabledSkills || []);
      if (enabled.has(id)) {
        enabled.delete(id);
      } else {
        enabled.add(id);
      }
      return { ...current, enabledSkills: Array.from(enabled) };
    });
  }, []);

  const toggleMcp = useCallback((id: string) => {
    setSettings((current) => {
      const enabled = new Set(current.enabledMcpServers || []);
      if (enabled.has(id)) {
        enabled.delete(id);
      } else {
        enabled.add(id);
      }
      return { ...current, enabledMcpServers: Array.from(enabled) };
    });
  }, []);

  const configureEnvKey = useCallback((presetId: string, key: string) => {
    setMcpSecretTarget({ presetId, key });
    setMcpSecretValue("");
  }, []);

  const selectMcpForSetup = useCallback(async (preset: McpPreset) => {
    const text = getMcpText(preset, language);
    const envKeys = mcpEnvKeysFromHint(text.envHint);
    const nextSettings = normalizeSettings({
      ...settings,
      mcpEnabled: true,
      enabledMcpServers: Array.from(new Set([...(settings.enabledMcpServers || []), preset.id]))
    });
    setSettings(nextSettings);
    const savedSettings = await desktop.saveSettings(nextSettings);
    setSettings(savedSettings);
    setMcpTestResult(null);
    if (envKeys.length > 0) {
      configureEnvKey(preset.id, envKeys[0]);
    } else {
      setMcpSecretTarget(null);
      setMcpSecretValue("");
      setTemplateMessage(t.mcp.selectedNoAuth(text.name));
    }
  }, [configureEnvKey, desktop, language, settings, t]);

  const openMcpGuide = useCallback(async (preset: McpPreset) => {
    const guide = mcpGuideForPreset(preset, language);
    if (!guide.url) return;
    const result = await desktop.openExternal(guide.url);
    if (!result.ok) {
      setTemplateMessage(result.error || t.mcp.configFailed);
    }
  }, [desktop, language, t]);

  const createSkill = useCallback(async () => {
    const result = await desktop.createSkillTemplate({
      settings,
      name: newSkillName,
      description: newSkillDescription
    });
    if (!result.ok || !result.skill) {
      setTemplateMessage(result.error || t.skills.saveFailed);
      return;
    }

    const nextSettings = {
      ...settings,
      enabledSkills: Array.from(new Set([...(settings.enabledSkills || []), result.skill.id]))
    };
    const savedSettings = await desktop.saveSettings(nextSettings);
    setSettings(savedSettings);
    await loadCustomization(savedSettings);
    setNewSkillName("");
    setNewSkillDescription("");
    setStatus({ type: "settingsSaved" });
    setTemplateMessage(t.skills.created(result.path || ""));
  }, [desktop, loadCustomization, newSkillDescription, newSkillName, settings, t]);

  const importSkills = useCallback(async () => {
    const sourcePath = await desktop.chooseDirectory();
    if (!sourcePath) return;
    const result = await desktop.importSkillDirectory({ settings, sourcePath });
    if (!result.ok || !result.skills?.length) {
      setTemplateMessage(result.error || t.skills.importFailed);
      return;
    }

    const importedIds = result.skills.map((skill) => skill.id);
    const nextSettings = {
      ...settings,
      enabledSkills: Array.from(new Set([...(settings.enabledSkills || []), ...importedIds]))
    };
    const savedSettings = await desktop.saveSettings(nextSettings);
    setSettings(savedSettings);
    await loadCustomization(savedSettings);
    setStatus({ type: "settingsSaved" });
    setTemplateMessage(t.skills.imported(importedIds.length));
  }, [desktop, loadCustomization, settings, t]);

  const addCustomMcpServer = useCallback(async () => {
    const id = customMcpId.trim();
    const command = customMcpCommand.trim();
    const url = customMcpUrl.trim();

    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      setTemplateMessage(t.mcp.customInvalidId);
      return;
    }
    if (!command && !url) {
      setTemplateMessage(t.mcp.customMissingTarget);
      return;
    }

    try {
      const config = parseMcpConfigDraft(mcpDraft);
      const urlServer = Boolean(url);
      config.servers[id] = {
        command: urlServer ? "" : command,
        args: urlServer ? [] : mcpArgsFromLines(customMcpArgs),
        env: parseMcpEnv(customMcpEnv),
        url: url || null,
        connect_timeout: null,
        execute_timeout: null,
        read_timeout: null,
        disabled: false,
        enabled: true,
        required: false,
        enabled_tools: [],
        disabled_tools: []
      };
      const content = JSON.stringify(config, null, 2);
      const result = await desktop.saveMcpConfig({
        settings,
        content
      });
      if (!result.ok || !result.path) {
        setTemplateMessage(result.error || t.mcp.configFailed);
        return;
      }
      const nextSettings = { ...settings, mcpConfigPath: result.path };
      const savedSettings = await desktop.saveSettings(nextSettings);
      setSettings(savedSettings);
      const draft = await loadCustomization(savedSettings);
      setCustomization(draft);
      setMcpDraft(result.content || draft.mcpConfigText || content);
      setMcpTestResult(null);
      setCustomMcpId("");
      setCustomMcpArgs("");
      setCustomMcpUrl("");
      setCustomMcpEnv("{}");
      setStatus({ type: "settingsSaved" });
      setTemplateMessage(t.mcp.customAdded(id));
    } catch {
      setTemplateMessage(t.mcp.customInvalidJson);
    }
  }, [customMcpArgs, customMcpCommand, customMcpEnv, customMcpId, customMcpUrl, desktop, loadCustomization, mcpDraft, settings, t]);

  const testMcpServers = useCallback(async () => {
    setMcpTesting(true);
    try {
      const result = await desktop.testMcpServers({ settings });
      setMcpTestResult(result);
      setTemplateMessage(result.servers.length === 0
        ? t.mcp.noServers
        : result.ok ? t.mcp.testOk : result.error || t.mcp.testFailed);
    } finally {
      setMcpTesting(false);
    }
  }, [desktop, settings, t]);

  const saveMcpEnvSecret = useCallback(async () => {
    const key = mcpSecretKey.trim();
    const value = mcpSecretValue.trim();
    const targetPresetId = mcpSecretTarget?.presetId || "";
    if (!key || !value) {
      setTemplateMessage(t.mcp.secretFailed);
      return;
    }
    setMcpSecretSaving(true);
    try {
      const result = await desktop.saveMcpEnvSecret({ name: key, value });
      if (!result.ok || !result.key) {
        setTemplateMessage(result.error || t.mcp.secretFailed);
        return;
      }
      const nextSettings = targetPresetId
        ? normalizeSettings({
          ...settings,
          mcpEnabled: true,
          enabledMcpServers: Array.from(new Set([...(settings.enabledMcpServers || []), targetPresetId]))
        })
        : settings;
      const savedSettings = targetPresetId ? await desktop.saveSettings(nextSettings) : settings;
      setSettings(savedSettings);
      setMcpSecretTarget(null);
      setMcpSecretValue("");
      const nextTest = await desktop.testMcpServers({ settings: savedSettings });
      setMcpTestResult(nextTest);
      setTemplateMessage(targetPresetId ? t.mcp.secretSavedAndEnabled(result.key) : t.mcp.secretSaved(result.key));
    } finally {
      setMcpSecretSaving(false);
    }
  }, [desktop, mcpSecretKey, mcpSecretTarget?.presetId, mcpSecretValue, settings, t]);

  const sendPrompt = useCallback(async (options?: {
    prompt?: string;
    clearComposer?: boolean;
    skipTaskBoard?: boolean;
  }) => {
    const prompt = String(options?.prompt ?? agentPrompt).trim();
    if (!prompt) return;
    if (!deriveInteractionState({ ...interactionStateBase, prompt }).canSubmit) return;

    let currentSession = findConversationSession(conversationStore, conversationStore.activeSessionId)
      || createConversationSession(settings.workspacePath, language, [createWelcomeMessage(language)]);
    if (!findConversationSession(conversationStore, currentSession.id)) {
      applyConversationStore(upsertConversationSession(conversationStore, currentSession, language));
    }

    const targetSessionId = currentSession.id;
    const baseRuntimeSettings = normalizeSettings({
      ...settings,
      launchAction: settings.launchAction,
      processStreamEnabled,
      model: selectedModelApiName
    });
    const routing = routePromptForRun(prompt, permissionMode, baseRuntimeSettings);
    const runtimeSettings = normalizeSettings({
      ...baseRuntimeSettings,
      ...routing.runtimeSettings,
      processStreamEnabled
    });
    const shouldPrepareTaskBoard = !options?.skipTaskBoard && shouldCreateTaskBoard({
      prompt,
      permissionMode,
      skillRoutingMode: baseRuntimeSettings.skillRoutingMode,
      activeSkillIds: routing.skillRoute.activeSkillIds
    });
    const displayPrompt = prompt;
    const finalRuntimePrompt = [
      capabilityContext,
      "",
      "User request:",
      routing.prompt
    ].join("\n");

    let pendingMessages: ChatMessage[] = currentSession.messages;
    commitConversationStore((current) => {
      const session = findConversationSession(current, targetSessionId) || currentSession;
      const isUntitled = !session.title || session.title === uiCopy[language].history.untitled;
      pendingMessages = appendRuntimePromptMessages(session.messages, displayPrompt, language, createId) as ChatMessage[];
      currentSession = {
        ...session,
        workspacePath: settings.workspacePath,
        title: isUntitled ? titleFromPrompt(displayPrompt, uiCopy[language].history.untitled) : session.title,
        updatedAt: new Date().toISOString(),
        messages: pendingMessages,
        taskBoards: session.taskBoards || []
      };
      return upsertConversationSession(current, currentSession, language);
    });
    setMessages(pendingMessages);
    setTaskBoardMessage("");
    setTaskBoardFallbackPrompt("");
    if (options?.clearComposer !== false) {
      setAgentPrompt("");
    }
    setStatus({ type: "launching" });
    terminalRawOutputBySessionRef.current[targetSessionId] = "";
    terminalOutputBySessionRef.current[targetSessionId] = "";
    if (activeSessionIdRef.current === targetSessionId) {
      renderTerminalForSession(targetSessionId);
    }

    if (baseRuntimeSettings.rememberWorkspace) {
      await desktop.saveSettings(baseRuntimeSettings);
    }
    const launchApiKey = apiKey.trim();
    if (launchApiKey) {
      const keyResult = await desktop.saveApiKey({ provider: baseRuntimeSettings.provider, apiKey: launchApiKey });
      if (!keyResult.ok) {
        setStatus({ type: "error", message: keyResult.error || t.settings.apiKeySaveFailed });
        return;
      }
    }

    try {
      let runtimeThreadId = currentSession.runtimeThreadId || "";
      if (!runtimeThreadId) {
        const created = await desktop.createRuntimeApiThread({
          workspacePath: settings.workspacePath,
          model: routing.modelRoute.apiModel,
          mode: shouldPrepareTaskBoard ? "plan" : permissionMode === "agent" ? "agent" : permissionMode,
          allowShell: shouldPrepareTaskBoard ? false : runtimeSettings.allowShell,
          settings: shouldPrepareTaskBoard ? { ...runtimeSettings, allowShell: false } : runtimeSettings
        });
        if (!created.ok || !created.thread?.id) {
          setStatus({ type: "error", message: created.error || t.status.launchFailed });
          return;
        }
        runtimeThreadId = created.thread.id;
        setRuntimeThreadDetails((current) => current[runtimeThreadId]
          ? current
          : {
            ...current,
            [runtimeThreadId]: {
              thread: created.thread!,
              turns: [],
              items: [],
              latest_seq: 0
            }
          });
        commitConversationStore((current) => updateConversationSession(current, targetSessionId, language, (session) => ({
          ...session,
          runtimeThreadId,
          updatedAt: new Date().toISOString()
        })));
      }

      if (shouldPrepareTaskBoard) {
        setTaskBoardBusy(true);
        setTaskBoardMessage(language === "zh" ? "正在生成任务拆解工作台…" : "Generating task board...");
        const decompositionPrompt = buildTaskDecompositionPrompt({
          sourcePrompt: prompt,
          model: routing.modelRoute.apiModel,
          activeSkillIds: routing.skillRoute.activeSkillIds,
          maxSubagents: runtimeSettings.maxSubagents,
          language,
          capabilityContext
        });
        const result = await desktop.startRuntimeApiThreadTurn({
          conversationId: targetSessionId,
          threadId: runtimeThreadId,
          workspacePath: settings.workspacePath,
          prompt: decompositionPrompt,
          model: routing.modelRoute.apiModel,
          mode: "plan",
          allowShell: false,
          settings: { ...runtimeSettings, allowShell: false }
        });
        if (!result.ok || !result.threadId || !result.detail) {
          const error = result.error || t.status.launchFailed;
          setTaskBoardMessage(error);
          setTaskBoardFallbackPrompt(prompt);
          setStatus({ type: "error", message: error });
          return;
        }
        setRuntimeThreadDetails((current) => ({ ...current, [result.threadId!]: result.detail! }));
        const parsed = parseTaskBoardPlan(latestRuntimeAssistantText(result.detail), {
          sourcePrompt: prompt,
          model: routing.modelRoute.apiModel,
          activeSkillIds: routing.skillRoute.activeSkillIds
        });
        if (!parsed.ok) {
          const error = language === "zh"
            ? `任务拆解失败：${parsed.error}`
            : `Task decomposition failed: ${parsed.error}`;
          setTaskBoardMessage(error);
          setTaskBoardFallbackPrompt(prompt);
          setStatus({ type: "error", message: parsed.error });
          return;
        }
        const assistantMessage: ChatMessage = {
          id: createId(),
          role: "assistant",
          title: language === "zh" ? "任务拆解工作台" : "Task Board",
          content: language === "zh"
            ? "已生成任务拆解工作台。确认后可以按任务板执行，或跳过任务板直接执行原任务。"
            : "Task board generated. You can execute from the board or skip it and run the original task directly."
        };
        const preparedPlan = propagateBlockedTaskItems(parsed.plan);
        commitConversationStore((current) => updateConversationSession(current, targetSessionId, language, (session) => ({
          ...session,
          runtimeThreadId: result.threadId,
          updatedAt: new Date().toISOString(),
          taskBoards: [...normalizeTaskBoardList(session.taskBoards), preparedPlan],
          activeTaskBoardId: preparedPlan.id,
          messages: [...session.messages.filter((message) => message.content !== (language === "zh" ? "正在等待运行时回复…" : "Waiting for runtime response...")), assistantMessage]
        })));
        if (activeSessionIdRef.current === targetSessionId) {
          setMessages((current) => [
            ...current.filter((message) => message.content !== (language === "zh" ? "正在等待运行时回复…" : "Waiting for runtime response...")),
            assistantMessage
          ]);
        }
        setTaskBoardMessage(language === "zh" ? "任务板已生成。" : "Task board generated.");
        setStatus({ type: "exited", exitCode: 0 });
        return;
      }

      const runtimePrompt = buildAnchoredRuntimePrompt(finalRuntimePrompt, currentSession.contextAnchors || [], language);
      const result = await desktop.startRuntimeApiThreadTurn({
        conversationId: targetSessionId,
        threadId: runtimeThreadId,
        workspacePath: settings.workspacePath,
        prompt: runtimePrompt,
        model: routing.modelRoute.apiModel,
        mode: permissionMode === "agent" ? "agent" : permissionMode,
        allowShell: runtimeSettings.allowShell,
        settings: runtimeSettings
      });
      if (!result.ok || !result.threadId || !result.detail) {
        setStatus({ type: "error", message: result.error || t.status.launchFailed });
        return;
      }
      const transcriptMessages = conversationMessagesFromRuntimeDetail(result.detail) as ChatMessage[];
      setRuntimeThreadDetails((current) => ({ ...current, [result.threadId!]: result.detail! }));
      commitConversationStore((current) => updateConversationSession(current, targetSessionId, language, (session) => ({
        ...session,
        runtimeThreadId: result.threadId,
        updatedAt: new Date().toISOString(),
        messages: transcriptMessages.length > 0 ? transcriptMessages : session.messages
      })));
      syncRuntimeDetailAnchors(targetSessionId, result.detail);
      if (transcriptMessages.length > 0) {
        setMessages(transcriptMessages);
      }
      setStatus({ type: "running" });
    } catch (error) {
      setStatus({ type: "error", message: error instanceof Error ? error.message : t.status.launchFailed });
    } finally {
      setTaskBoardBusy(false);
    }
  }, [agentPrompt, apiKey, applyConversationStore, capabilityContext, commitConversationStore, conversationStore, desktop, interactionStateBase, language, permissionMode, processStreamEnabled, renderTerminalForSession, routePromptForRun, selectedModelApiName, settings, syncRuntimeDetailAnchors, t]);

  const executeTaskBoard = useCallback(async (board: TaskBoardPlan, retryItemId = "") => {
    if (taskBoardBusy || activeSessionBusy) return;
    let currentSession = findConversationSession(conversationStore, conversationStore.activeSessionId)
      || createConversationSession(settings.workspacePath, language, [createWelcomeMessage(language)]);
    if (!findConversationSession(conversationStore, currentSession.id)) {
      applyConversationStore(upsertConversationSession(conversationStore, currentSession, language));
    }
    const targetSessionId = currentSession.id;
    const runtimeModel = board.model || selectedModelApiName;
    const runtimeSettings = normalizeSettings({
      ...settings,
      model: runtimeModel,
      enabledSkills: board.activeSkillIds.length > 0 ? board.activeSkillIds : settings.enabledSkills,
      processStreamEnabled
    });
    const permissionModeForRuntime = permissionMode === "agent" ? "agent" : permissionMode;
    const saveBoard = (nextBoard: TaskBoardPlan) => {
      commitConversationStore((current) => updateConversationSession(current, targetSessionId, language, (session) => {
        const boards = normalizeTaskBoardList(session.taskBoards);
        const replaced = boards.some((candidate) => candidate.id === nextBoard.id)
          ? boards.map((candidate) => candidate.id === nextBoard.id ? nextBoard : candidate)
          : [...boards, nextBoard];
        return {
          ...session,
          updatedAt: new Date().toISOString(),
          taskBoards: replaced,
          activeTaskBoardId: nextBoard.id
        };
      }));
    };
    const failItem = (plan: TaskBoardPlan, itemId: string, reason: string) => propagateBlockedTaskItems({
      ...plan,
      items: plan.items.map((item) => item.id === itemId
        ? {
          ...item,
          status: "failed",
          blockedReason: reason,
          lastActivityAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        }
        : item)
    });

    setTaskBoardBusy(true);
    setTaskBoardFallbackPrompt("");
    setStatus({ type: "launching" });
    const launchApiKey = apiKey.trim();
    if (launchApiKey) {
      const keyResult = await desktop.saveApiKey({ provider: runtimeSettings.provider, apiKey: launchApiKey });
      if (!keyResult.ok) {
        setTaskBoardBusy(false);
        setStatus({ type: "error", message: keyResult.error || t.settings.apiKeySaveFailed });
        return;
      }
    }

    try {
      let workingBoard = applyTaskBoardRuntimeDetails(board, runtimeThreadDetails);
      if (retryItemId) {
        workingBoard = resetTaskBoardItemForRetry(workingBoard, retryItemId);
      }
      workingBoard = propagateBlockedTaskItems(workingBoard);
      saveBoard(workingBoard);
      const runId = createTaskBoardRunId(workingBoard.id);
      let ranAny = false;

      while (true) {
        const nextItem = nextRunnableTaskBoardItem(workingBoard);
        if (!nextItem) break;
        if (retryItemId && nextItem.id !== retryItemId) break;
        ranAny = true;
        workingBoard = queueTaskBoardItem(workingBoard, nextItem.id, runId);
        saveBoard(workingBoard);
        setTaskBoardMessage(language === "zh"
          ? `正在执行任务：${nextItem.title}`
          : `Running task: ${nextItem.title}`);

        const created = await desktop.createRuntimeApiThread({
          workspacePath: settings.workspacePath,
          model: runtimeModel,
          mode: permissionModeForRuntime,
          allowShell: runtimeSettings.allowShell,
          settings: runtimeSettings
        });
        if (!created.ok || !created.thread?.id) {
          workingBoard = failItem(workingBoard, nextItem.id, created.error || t.status.launchFailed);
          saveBoard(workingBoard);
          setStatus({ type: "error", message: created.error || t.status.launchFailed });
          break;
        }

        const threadId = created.thread.id;
        workingBoard = bindTaskBoardItemRuntime(workingBoard, nextItem.id, threadId);
        saveBoard(workingBoard);
        setRuntimeThreadDetails((current) => current[threadId]
          ? current
          : {
            ...current,
            [threadId]: {
              thread: created.thread!,
              turns: [],
              items: [],
              latest_seq: 0
            }
          });
        const currentItem = workingBoard.items.find((item) => item.id === nextItem.id) || nextItem;
        const itemPrompt = buildTaskBoardItemExecutionPrompt({
          plan: workingBoard,
          item: currentItem,
          language,
          capabilityContext
        });
        const runtimePrompt = buildAnchoredRuntimePrompt(itemPrompt, currentSession.contextAnchors || [], language);
        const result = await desktop.startRuntimeApiThreadTurn({
          conversationId: targetSessionId,
          threadId,
          workspacePath: settings.workspacePath,
          prompt: runtimePrompt,
          model: runtimeModel,
          mode: permissionModeForRuntime,
          allowShell: runtimeSettings.allowShell,
          settings: runtimeSettings
        });
        if (!result.ok || !result.threadId || !result.detail) {
          workingBoard = failItem(workingBoard, nextItem.id, result.error || t.status.launchFailed);
          saveBoard(workingBoard);
          setStatus({ type: "error", message: result.error || t.status.launchFailed });
          break;
        }

        let latestDetail = result.detail;
        let detailForState = latestDetail;
        setRuntimeThreadDetails((current) => ({ ...current, [result.threadId!]: detailForState }));
        if (result.turn?.id) {
          workingBoard = bindTaskBoardItemRuntime(workingBoard, nextItem.id, result.threadId, result.turn.id);
        }
        while (true) {
          workingBoard = applyTaskRuntimeDetail(workingBoard, nextItem.id, latestDetail);
          saveBoard(workingBoard);
          const observedItem = workingBoard.items.find((item) => item.id === nextItem.id);
          if (!observedItem || (observedItem.status !== "queued" && observedItem.status !== "running")) break;
          await waitForMs(1500);
          const refreshed = await desktop.getRuntimeApiThread({ threadId: result.threadId, settings: runtimeSettings });
          if (!refreshed.ok || !refreshed.detail) {
            workingBoard = failItem(workingBoard, nextItem.id, refreshed.error || t.status.launchFailed);
            saveBoard(workingBoard);
            setStatus({ type: "error", message: refreshed.error || t.status.launchFailed });
            break;
          }
          latestDetail = refreshed.detail;
          detailForState = latestDetail;
          setRuntimeThreadDetails((current) => ({ ...current, [result.threadId!]: detailForState }));
        }
        const finishedItem = workingBoard.items.find((item) => item.id === nextItem.id);
        if (finishedItem?.status !== "completed") {
          const reason = finishedItem?.blockedReason || (language === "zh" ? "任务未完成。" : "Task did not complete.");
          setTaskBoardMessage(reason);
          setStatus(finishedItem?.status === "failed" ? { type: "error", message: reason } : { type: "stopped" });
          break;
        }
        if (retryItemId) break;
      }

      const summary = taskBoardRunSummary(workingBoard);
      if (!ranAny) {
        setTaskBoardMessage(language === "zh"
          ? "没有可执行任务。请检查依赖、失败或阻塞原因。"
          : "No runnable task is available. Check dependencies, failures, or blocked reasons.");
        setStatus({ type: "ready" });
      } else if (summary.completed === summary.total) {
        setTaskBoardMessage(language === "zh" ? "任务板已全部完成。" : "Task board completed.");
        setStatus({ type: "exited", exitCode: 0 });
      } else if (summary.failed > 0) {
        setTaskBoardMessage(language === "zh"
          ? `任务板暂停：${summary.failed} 个失败，${summary.blocked} 个阻塞。`
          : `Task board paused: ${summary.failed} failed, ${summary.blocked} blocked.`);
      } else {
        setTaskBoardMessage(language === "zh"
          ? `任务板暂停：${summary.completed}/${summary.total} 已完成。`
          : `Task board paused: ${summary.completed}/${summary.total} completed.`);
        setStatus({ type: "ready" });
      }
    } catch (error) {
      setStatus({ type: "error", message: error instanceof Error ? error.message : t.status.launchFailed });
    } finally {
      setTaskBoardBusy(false);
    }
  }, [activeSessionBusy, apiKey, applyConversationStore, capabilityContext, commitConversationStore, conversationStore, desktop, language, permissionMode, processStreamEnabled, runtimeThreadDetails, selectedModelApiName, settings, t, taskBoardBusy]);

  const executeOriginalPrompt = useCallback(async (prompt: string) => {
    setTaskBoardFallbackPrompt("");
    setTaskBoardMessage("");
    await sendPrompt({
      prompt,
      skipTaskBoard: true,
      clearComposer: false
    });
  }, [sendPrompt]);

  const recallArchivedContext = useCallback(async () => {
    if (!activeRuntimeThreadDetail || activeSessionBusy) return;
    const topic = activeRuntimeContextHealth.latestUserPrompt || agentPrompt.trim() || (language === "zh" ? "当前任务" : "current task");
    await sendPrompt({
      prompt: buildRecallArchivePrompt(topic, language),
      clearComposer: false
    });
  }, [activeRuntimeContextHealth.latestUserPrompt, activeRuntimeThreadDetail, activeSessionBusy, agentPrompt, language, sendPrompt]);

  const pinContextAnchor = useCallback(() => {
    const sessionId = activeSession?.id;
    const text = contextAnchorDraft.trim();
    if (!sessionId || !text) return;
    const nextAnchor: ContextAnchor = {
      id: createId(),
      text,
      createdAt: new Date().toISOString()
    };
    commitConversationStore((current) => updateConversationSession(current, sessionId, language, (session) => ({
      ...session,
      updatedAt: new Date().toISOString(),
      contextAnchors: normalizeContextAnchors([...(session.contextAnchors || []), nextAnchor])
    })));
  }, [activeSession?.id, commitConversationStore, contextAnchorDraft, language]);

  const removeContextAnchor = useCallback((anchorId: string) => {
    const sessionId = activeSession?.id;
    if (!sessionId) return;
    commitConversationStore((current) => updateConversationSession(current, sessionId, language, (session) => ({
      ...session,
      updatedAt: new Date().toISOString(),
      contextAnchors: normalizeContextAnchors((session.contextAnchors || []).filter((anchor) => anchor.id !== anchorId))
    })));
  }, [activeSession?.id, commitConversationStore, language]);

  const handleComposerKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposerShortcut(event)) return;
    event.preventDefault();
    void sendPrompt();
  }, [sendPrompt]);

  const createProjectConversation = useCallback((workspacePath: string) => {
    const normalizedWorkspacePath = workspacePath.trim();
    if (!normalizedWorkspacePath) {
      setStatus({ type: "error", message: t.topbar.noWorkspace });
      return;
    }
    const nextMessages = [createNewConversationMessage(language)];
    const session = createConversationSession(normalizedWorkspacePath, language, nextMessages);
    applyConversationStore(upsertConversationSession(conversationStore, session, language));
    activeSessionIdRef.current = session.id;
    setExpandedProjectIds(() => new Set([session.projectId]));
    renderTerminalForSession(session.id);
    setSettings((current) => ({ ...current, workspacePath: normalizedWorkspacePath }));
    setMessages(nextMessages);
    setAgentPrompt("");
    setTaskBoardBusy(false);
    setTaskBoardMessage("");
    setTaskBoardFallbackPrompt("");
    setLastSkillRoute(null);
    setLastModelRoute(null);
    setMainView("chat");
    setStatus({ type: "ready" });
  }, [applyConversationStore, conversationStore, language, renderTerminalForSession, t.topbar.noWorkspace]);

  const newConversation = useCallback(() => {
    createProjectConversation(selectedWorkspacePath);
  }, [createProjectConversation, selectedWorkspacePath]);

  const selectProject = useCallback((project: ConversationProject) => {
    if (!project.workspacePath.trim()) return;
    const projectIsExpanded = expandedProjectIds.has(project.id);
    setExpandedProjectIds((current) => {
      const projectIsExpanded = current.has(project.id);
      return projectIsExpanded ? new Set<string>() : new Set([project.id]);
    });
    const session = project.sessions[0];
    setSettings((current) => ({ ...current, workspacePath: project.workspacePath }));
    if (!projectIsExpanded && session) {
      applyConversationStore({
        ...conversationStore,
        activeSessionId: session.id
      });
      activeSessionIdRef.current = session.id;
      setMessages(session.messages.length ? session.messages : [createNewConversationMessage(language)]);
      renderTerminalForSession(session.id);
    }
    setAgentPrompt("");
    setTaskBoardBusy(false);
    setTaskBoardMessage("");
    setTaskBoardFallbackPrompt("");
    setLastSkillRoute(null);
    setLastModelRoute(null);
    setMainView("chat");
  }, [applyConversationStore, conversationStore, expandedProjectIds, language, renderTerminalForSession]);

  const selectConversation = useCallback((sessionId: string) => {
    const session = findConversationSession(conversationStore, sessionId);
    if (!session) return;
    applyConversationStore({ ...conversationStore, activeSessionId: sessionId });
    activeSessionIdRef.current = session.id;
    setExpandedProjectIds(() => new Set([session.projectId]));
    setMessages(session.messages.length ? session.messages : [createWelcomeMessage(language)]);
    renderTerminalForSession(session.id);
    setAgentPrompt("");
    setTaskBoardBusy(false);
    setTaskBoardMessage("");
    setTaskBoardFallbackPrompt("");
    setLastSkillRoute(null);
    setLastModelRoute(null);
    setMainView("chat");
    if (session.workspacePath) {
      setSettings((current) => ({ ...current, workspacePath: session.workspacePath }));
    }
  }, [applyConversationStore, conversationStore, language, renderTerminalForSession]);

  const removeConversation = useCallback((sessionId: string) => {
    const nextStore = deleteConversationSession(conversationStore, sessionId);
    const nextSession = findConversationSession(nextStore, nextStore.activeSessionId);
    delete terminalRawOutputBySessionRef.current[sessionId];
    delete terminalOutputBySessionRef.current[sessionId];
    applyConversationStore(nextStore);
    activeSessionIdRef.current = nextSession?.id || "";
    setExpandedProjectIds(() => nextSession?.projectId ? new Set([nextSession.projectId]) : new Set<string>());
    setMessages(nextSession?.messages.length ? nextSession.messages : [createWelcomeMessage(language)]);
    renderTerminalForSession(nextSession?.id);
    setTaskBoardBusy(false);
    setTaskBoardMessage("");
    setTaskBoardFallbackPrompt("");
    setLastSkillRoute(null);
    setLastModelRoute(null);
    if (nextSession?.workspacePath) {
      setSettings((current) => ({ ...current, workspacePath: nextSession.workspacePath }));
    }
  }, [applyConversationStore, conversationStore, language, renderTerminalForSession]);

  const restartRemoteBridge = useCallback(async () => {
    const nextStatus = await desktop.restartRemoteBridge();
    setRemoteStatus(nextStatus);
    setRemoteMessage(nextStatus.running ? t.remote.running : t.remote.stopped);
  }, [desktop, t]);

  const rotateRemoteToken = useCallback(async () => {
    const result = await desktop.rotateRemoteToken();
    setSettings(result.settings);
    setRemoteStatus(result.status);
    setRemoteMessage(t.remote.tokenUpdated);
  }, [desktop, t]);

  const loginRemoteAccount = useCallback(async () => {
    const accountId = loginAccount.trim();
    if (!accountId) {
      setRemoteMessage(t.remote.loginRequired);
      return;
    }
    const result = await desktop.loginRemoteAccount({
      accountId,
      email: accountId,
      displayName: loginDisplayName.trim()
    });
    if (result.status) setRemoteStatus(result.status);
    setRemoteMessage(result.ok ? t.remote.loginSaved : result.error || t.remote.loginRequired);
  }, [desktop, loginAccount, loginDisplayName, t]);

  const logoutRemoteAccount = useCallback(async () => {
    const result = await desktop.logoutRemoteAccount();
    if (result.status) setRemoteStatus(result.status);
    setPairingCode("");
    setRemoteMessage(result.ok ? t.remote.logoutSaved : result.error || t.remote.logoutSaved);
  }, [desktop, t]);

  const startRemotePairing = useCallback(async () => {
    const result = await desktop.startRemotePairing();
    if (result.status) setRemoteStatus(result.status);
    if (result.ok && result.pairing) {
      setPairingCode(result.pairing.code);
      setRemoteMessage(t.remote.pairingStarted);
      return;
    }
    setRemoteMessage(result.error || t.remote.pairingFailed);
  }, [desktop, t]);

  const revokeRemoteDevice = useCallback(async (deviceId: string) => {
    const result = await desktop.revokeRemoteDevice(deviceId);
    if (result.status) setRemoteStatus(result.status);
    setRemoteMessage(result.ok ? t.remote.deviceRevoked : result.error || t.remote.deviceRevoked);
  }, [desktop, t]);

  const pushTestUpdateNotice = useCallback(async () => {
    const result = await desktop.pushUpdateNotice({
      accountId: remoteStatus?.auth.account?.accountId,
      version: "test",
      title: t.remote.testUpdateTitle,
      body: t.remote.testUpdateBody
    });
    setRemoteStatus(await desktop.getRemoteStatus());
    setRemoteMessage(result.ok ? t.remote.testUpdateSent : result.error || t.remote.testUpdateFailed);
  }, [desktop, remoteStatus?.auth.account?.accountId, t]);

  const copyRemoteText = useCallback(async (value: string, label: string) => {
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    setRemoteMessage(t.remote.copied(label));
  }, [t]);

  const applyGitResult = useCallback((result: GitActionResult, successMessage: string) => {
    if (result.status) {
      setGitStatus(result.status);
      if (result.status.originUrl) {
        setGitRemoteUrl(result.status.originUrl);
      }
    }
    setGitMessage(result.ok ? successMessage : result.error || result.output || t.git.actionFailed);
    setGitMessageKind(result.ok ? "info" : "error");
    return result.ok;
  }, [t]);

  const refreshGitStatus = useCallback(async () => {
    setGitBusy(true);
    try {
      const result = await loadGitStatus();
      setGitMessage(result.ok ? "" : result.error || t.git.actionFailed);
      setGitMessageKind(result.ok ? "info" : "error");
    } finally {
      setGitBusy(false);
    }
  }, [loadGitStatus, t]);

  const initGitRepository = useCallback(async () => {
    setGitBusy(true);
    try {
      const result = await desktop.initGitRepository(settings.workspacePath);
      applyGitResult(result, t.git.initOk);
    } finally {
      setGitBusy(false);
    }
  }, [applyGitResult, desktop, settings.workspacePath, t]);

  const saveGitRemote = useCallback(async () => {
    setGitBusy(true);
    try {
      const result = await desktop.setGitRemote({
        workspacePath: settings.workspacePath,
        remoteUrl: gitRemoteUrl
      });
      applyGitResult(result, t.git.remoteOk);
    } finally {
      setGitBusy(false);
    }
  }, [applyGitResult, desktop, gitRemoteUrl, settings.workspacePath, t]);

  const switchGitBranch = useCallback(async (branchName: string) => {
    if (!branchName || !gitStatus?.isRepo) return;
    if (gitStatus.hasChanges) {
      setGitMessage(t.git.dirtyBranchBlocked);
      setGitMessageKind("error");
      return;
    }
    setGitBusy(true);
    try {
      const result = await desktop.switchGitBranch({
        workspacePath: settings.workspacePath,
        branchName
      });
      applyGitResult(result, t.git.switchBranchOk);
    } finally {
      setGitBusy(false);
    }
  }, [applyGitResult, desktop, gitStatus?.hasChanges, gitStatus?.isRepo, settings.workspacePath, t]);

  const runGitRepositoryAction = useCallback(async (action: "fetch" | "pull" | "push") => {
    setGitBusy(true);
    try {
      const payload = { workspacePath: settings.workspacePath };
      const result = action === "fetch"
        ? await desktop.fetchGitRepository(payload)
        : action === "pull"
          ? await desktop.pullGitRepository(payload)
          : await desktop.pushGitRepository(payload);
      const successMessage = action === "fetch" ? t.git.fetchOk : action === "pull" ? t.git.pullOk : t.git.pushOk;
      applyGitResult(result, successMessage);
    } finally {
      setGitBusy(false);
    }
  }, [applyGitResult, desktop, settings.workspacePath, t]);

  const commitGitRepository = useCallback(async () => {
    setGitBusy(true);
    try {
      const result = await desktop.commitGitRepository({
        workspacePath: settings.workspacePath,
        message: gitCommitMessage
      });
      if (applyGitResult(result, t.git.commitOk)) {
        setGitCommitMessage("");
      }
    } finally {
      setGitBusy(false);
    }
  }, [applyGitResult, desktop, gitCommitMessage, settings.workspacePath, t]);

  const previewGitDiffSummary = useCallback(async () => {
    setGitDiffBusy(true);
    try {
      const result = await desktop.getGitDiffSummary({ workspacePath: settings.workspacePath });
      if (result.status) {
        setGitStatus(result.status);
      }
      setGitDiffSummary(result.output || result.error || "");
      setGitMessage(result.ok ? t.git.previewOk : result.error || t.git.actionFailed);
      setGitMessageKind(result.ok ? "info" : "error");
    } finally {
      setGitDiffBusy(false);
    }
  }, [desktop, settings.workspacePath, t]);

  const copyGitRemote = useCallback(async () => {
    const value = gitStatus?.originUrl || gitRemoteUrl;
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    setGitMessage(t.git.copied);
    setGitMessageKind("info");
  }, [gitRemoteUrl, gitStatus?.originUrl, t]);

  const openToolPage = useCallback((page: ToolPage) => {
    setInspectorPanel(null);
    setToolPage(page);
    setMainView("tools");
  }, []);

  const openScheduledTasksPage = useCallback(() => {
    setInspectorPanel(null);
    setMainView("tasks");
    setAutomationMessage("");
  }, []);

  const toggleInspectorPanel = useCallback((panel: Exclude<InspectorPanel, null>) => {
    setInspectorPanel((current) => current === panel ? null : panel);
  }, []);

  const messageListClassName = mainView === "tools" || mainView === "tasks" ? "message-list tool-message-list" : "message-list";
  const conversationLayoutClassName = processStreamEnabled
    ? "conversation-layout conversation-layout-with-stream"
    : "conversation-layout conversation-layout-single";
  const terminalCardClassName = "terminal-card stream-output-card";
  const latestHookEvent = desktopHookEvents.at(-1);
  const routeIntentText = lastSkillRoute?.intents.length
    ? lastSkillRoute.intents.map((intent) => `${intent.id} ${intent.score}`).join(", ")
    : "";
  const selectedRouteCandidates = (lastSkillRoute?.candidates || [])
    .filter((candidate) => candidate.selected)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  const rejectedRouteSkills = (lastSkillRoute?.rejectedSkills || []).slice(0, 3);
  const routingPanel = lastSkillRoute || lastModelRoute ? (
    <section className="runtime-routing-panel">
      <div>
        <strong>{language === "zh" ? "本轮路由" : "Turn routing"}</strong>
        <p>{lastSkillRoute?.routeDebug.summary || latestHookEvent?.summary || (language === "zh" ? "发送前会按任务选择 Skill 与模型。" : "Skills and model are selected per turn.")}</p>
      </div>
      <div className="runtime-routing-chips">
        {routeIntentText ? (
          <span className="status-chip">
            {language === "zh" ? `意图：${routeIntentText}` : `Intent: ${routeIntentText}`}
          </span>
        ) : null}
        <span className="status-chip enabled">
          {language === "zh" ? `Skill：${lastSkillRoute?.activeSkillIds.length ? lastSkillRoute.activeSkillIds.join(", ") : "无"}` : `Skills: ${lastSkillRoute?.activeSkillIds.length ? lastSkillRoute.activeSkillIds.join(", ") : "none"}`}
        </span>
        {lastModelRoute ? (
          <span className="status-chip">
            {language === "zh" ? `模型：${lastModelRoute.apiModel} (${lastModelRoute.profile.label})` : `Model: ${lastModelRoute.apiModel} (${lastModelRoute.profile.label})`}
          </span>
        ) : null}
      </div>
      {lastSkillRoute?.matches.length ? (
        <div className="runtime-routing-reasons">
          {lastSkillRoute.matches.map((match) => (
            <small key={`${match.skillId}-${match.source}`}>{match.skillId}: {match.reason}{typeof match.score === "number" && Number.isFinite(match.score) ? ` (${match.score})` : ""}</small>
          ))}
        </div>
      ) : null}
      {selectedRouteCandidates.length || rejectedRouteSkills.length ? (
        <div className="runtime-routing-reasons">
          {selectedRouteCandidates.map((candidate) => (
            <small key={`candidate-${candidate.skillId}`}>
              {language === "zh" ? "候选" : "Candidate"} {candidate.skillId}: {candidate.score}
            </small>
          ))}
          {rejectedRouteSkills.map((skill) => (
            <small key={`rejected-${skill.skillId}`}>
              {language === "zh" ? "排除" : "Rejected"} {skill.skillId}: {skill.reason}
            </small>
          ))}
        </div>
      ) : null}
    </section>
  ) : null;
  const renderMcpTestList = (servers: McpServerTest[]) => (
    <section className="mcp-test-list">
      {servers.length === 0 ? <p>{t.mcp.noServers}</p> : null}
      {servers.map((server) => {
        const preset = mcpPresets.find((candidate) => candidate.id === server.id);
        const serverName = preset ? getMcpText(preset, language).name : server.id;
        return (
          <div key={server.id} className="mcp-test-row">
            <div>
              <strong>{serverName}</strong>
              <span className={server.injectable ? "status-chip enabled" : "status-chip warning"}>
                {server.injectable ? t.mcp.injectable : t.mcp.notInjected}
              </span>
            </div>
            <code>{server.url || [server.command, ...server.args].filter(Boolean).join(" ")}</code>
            {server.warnings.length > 0 ? (
              <ul>
                {server.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            ) : null}
          </div>
        );
      })}
    </section>
  );
  const renderMcpTestSection = (servers: McpServerTest[] | null) => (servers ? renderMcpTestList(servers) : null);
  const runtimeApiState = runtimeApiStatus?.state || "idle";
  const runtimeApiStateText = t.runtimeApi[runtimeApiState];
  const runtimeApiUrl = runtimeApiStatus?.url || (runtimeApiInfo?.port ? `http://127.0.0.1:${runtimeApiInfo.port}` : "");
  const runtimeApiPendingApprovals = runtimeApiStatus?.pendingApprovals || [];
  const runtimeApiPendingUserInputs = runtimeApiStatus?.pendingUserInputs || [];
  const interactionLabel = interactionPhaseLabel(interactionState, language);
  const interactionDetail = interactionDetailText(interactionState, language);
  const runtimeApiPanel = (
    <section className={runtimeApiStatus?.connected ? "runtime-api-panel connected" : "runtime-api-panel"}>
      <div className="tool-section-head runtime-api-head">
        <div>
          <h3>{t.runtimeApi.title}</h3>
          <p>{t.runtimeApi.subtitle}</p>
        </div>
        <div className="runtime-api-actions">
          <span className={`status-chip runtime-api-status ${runtimeApiState}`}>
            {runtimeApiLoading ? t.runtimeApi.starting : runtimeApiStateText}
          </span>
          <button type="button" className="secondary" onClick={refreshRuntimeApi} disabled={runtimeApiLoading}>
            <RefreshCw size={16} aria-hidden />
            {t.runtimeApi.refresh}
          </button>
        </div>
      </div>
      {runtimeApiMessage ? (
        <p className="runtime-api-message">
          <CircleAlert size={15} aria-hidden />
          {runtimeApiMessage}
        </p>
      ) : null}
      <div className="runtime-api-grid">
        <article className="runtime-api-column">
          <div className="runtime-api-column-title">
            <Server size={16} aria-hidden />
            <strong>{t.runtimeApi.runtimeInfo}</strong>
          </div>
          <div className="runtime-api-kv">
            <span>URL</span>
            <code>{runtimeApiUrl || "-"}</code>
            <span>Version</span>
            <code>{String(runtimeApiInfo?.version || runtimeApiStatus?.info?.version || "-")}</code>
            <span>Auth</span>
            <code>{runtimeApiInfo?.auth_required || runtimeApiStatus?.info?.auth_required ? t.runtimeApi.authRequired : t.runtimeApi.authOff}</code>
          </div>
        </article>

        <article className="runtime-api-column">
          <div className="runtime-api-column-title">
            <BookOpen size={16} aria-hidden />
            <strong>{t.runtimeApi.skills}</strong>
          </div>
          {runtimeApiSkills.length > 0 ? (
            <div className="runtime-api-list">
              {runtimeApiSkills.slice(0, 6).map((skill) => (
                <button
                  type="button"
                  key={skill.id || skill.name}
                  className={skill.enabled ? "runtime-api-row enabled" : "runtime-api-row"}
                  onClick={() => toggleRuntimeApiSkill(skill)}
                >
                  <span>
                    <strong>{skill.name || skill.id}</strong>
                    <small>{skill.runtimeState?.state || (skill.enabled ? "enabled" : "disabled")}</small>
                    <small>{skill.runtimeState?.reason || skill.description || skill.path || ""}</small>
                  </span>
                  <span className={skill.enabled ? "switch on" : "switch"} />
                </button>
              ))}
            </div>
          ) : (
            <p className="runtime-api-empty">{t.runtimeApi.noSkills}</p>
          )}
        </article>

        <article className="runtime-api-column">
          <div className="runtime-api-column-title">
            <Plug size={16} aria-hidden />
            <strong>{t.runtimeApi.mcp}</strong>
          </div>
          {runtimeApiMcpServers.length > 0 ? (
            <div className="runtime-api-list compact">
              {runtimeApiMcpServers.slice(0, 6).map((server) => (
                <div key={server.id || server.name} className={server.enabled ? "runtime-api-row enabled" : "runtime-api-row"}>
                  <span>
                    <strong>{server.name || server.id}</strong>
                    <small>{server.runtimeState?.state || server.status || "disabled"}</small>
                    <small>{server.runtimeState?.reason || server.status || server.command || server.url || ""}</small>
                  </span>
                  {server.enabled ? <CheckCircle2 size={15} aria-hidden /> : <CircleAlert size={15} aria-hidden />}
                </div>
              ))}
            </div>
          ) : (
            <p className="runtime-api-empty">{t.runtimeApi.noMcp}</p>
          )}
        </article>

        <article className="runtime-api-column">
          <div className="runtime-api-column-title">
            <Layers3 size={16} aria-hidden />
            <strong>{language === "zh" ? "能力状态" : "Capabilities"}</strong>
          </div>
          {capabilityRecords.length > 0 ? (
            <div className="runtime-api-list compact">
              {capabilityRecords.slice(0, 8).map((record) => {
                const isCallable = record.runtimeState.callable && !record.runtimeState.failed && !record.runtimeState.approvalBlocked;
                const isWarning = record.runtimeState.selected && !isCallable;
                return (
                  <div
                    key={record.id}
                    className={`runtime-api-row capability ${isCallable ? "enabled" : ""} ${isWarning ? "warning" : ""}`}
                  >
                    <span>
                      <strong>{record.name}</strong>
                      <small>{record.kind} · {record.permission} · {record.runtimeState.state}</small>
                      <small>{record.reason || record.runtimeState.reason || record.description}</small>
                    </span>
                    {isCallable ? <CheckCircle2 size={15} aria-hidden /> : <CircleAlert size={15} aria-hidden />}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="runtime-api-empty">{language === "zh" ? "暂无能力记录" : "No capability records"}</p>
          )}
        </article>
      </div>
      <div className="runtime-api-approvals">
        <strong>{t.runtimeApi.approvals}</strong>
        {runtimeApiPendingUserInputs.length > 0 ? (
          <span>{language === "zh" ? `待回答问题 ${runtimeApiPendingUserInputs.length}` : `${runtimeApiPendingUserInputs.length} question(s) waiting`}</span>
        ) : null}
        {runtimeApiPendingApprovals.length > 0 ? (
          runtimeApiPendingApprovals.map((approval) => (
            <div key={approval.id || approval.approvalId || approval.title} className="runtime-api-approval-row">
              <span>{approval.title || approval.message || approval.action || approval.id || approval.approvalId}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => desktop.decideRuntimeApiApproval({
                  approvalId: String(approval.id || approval.approvalId || ""),
                  decision: "deny",
                  settings
                })}
              >
                {language === "zh" ? "拒绝" : "Deny"}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => desktop.decideRuntimeApiApproval({
                  approvalId: String(approval.id || approval.approvalId || ""),
                  decision: "allow",
                  settings
                })}
              >
                {language === "zh" ? "允许" : "Allow"}
              </button>
            </div>
          ))
        ) : (
          <span>{t.runtimeApi.noApprovals}</span>
        )}
      </div>
    </section>
  );
  const parentRuntimeTurns = runtimeOrchestratorSnapshot.turns
    .filter((turn) => turn.status === "queued" || turn.status === "running" || turn.status === "cancelling");
  const visibleRuntimeAgents = runtimeSnapshot.agents;
  const hasRunningRuntimeSession = runtimeSnapshot.status === "running";
  const activeRuntimeCount = parentRuntimeTurns.length
    + runtimeSnapshot.counts.running
    + (hasRunningRuntimeSession && parentRuntimeTurns.length === 0 && runtimeSnapshot.counts.running === 0 ? 1 : 0);
  const shouldShowAgentRuntimeBoard = activeRuntimeCount > 0 || visibleRuntimeAgents.length > 0;
  const parentRuntimeLabel = language === "zh" ? "当前运行" : "Current Run";
  const childAgentLabel = language === "zh" ? "子 Agent" : "Child Agents";
  const agentRuntimeBoard = (
    <section className="agent-runtime-board" aria-label={t.runtimeAgents.title}>
      <div className="agent-runtime-board-main">
        <div className={activeRuntimeCount > 0 ? "agent-runtime-count active" : "agent-runtime-count"}>
          {activeRuntimeCount > 0 ? <RunningActivityMark compact /> : <LoaderCircle size={16} aria-hidden />}
          <strong>{activeRuntimeCount}</strong>
        </div>
        <div>
          <span>{t.runtimeAgents.title}</span>
          <p>{activeRuntimeCount > 0
            ? t.runtimeAgents.runningCount(activeRuntimeCount)
            : visibleRuntimeAgents.length > 0
              ? t.runtimeAgents.trackedCount(visibleRuntimeAgents.length)
              : t.runtimeAgents.noAgents}</p>
        </div>
      </div>
      {parentRuntimeTurns.length > 0 ? (
        <div className="agent-runtime-active-list">
          <div className="agent-runtime-section-title">{parentRuntimeLabel}</div>
          {parentRuntimeTurns.map((turn) => (
            <article key={turn.turnId}>
              <TerminalSquare size={14} aria-hidden />
              <span>{turn.prompt || turn.turnId}</span>
              <b>{turn.status === "queued"
                ? t.runtimeAgents.statuses.queued
                : turn.status === "cancelling"
                  ? t.runtimeAgents.statuses.cancelling
                  : t.runtimeAgents.statuses.running}</b>
            </article>
          ))}
        </div>
      ) : null}
      {visibleRuntimeAgents.length > 0 ? (
        <div className="agent-runtime-active-list">
          <div className="agent-runtime-section-title">{childAgentLabel}</div>
          {visibleRuntimeAgents.map((agent) => (
            <article key={agent.id}>
              <Bot size={14} aria-hidden />
              <span>
                {agent.name}
                <small>{agent.typeLabel || agent.type || "Custom"} · {agent.classificationSource === "observed" ? (language === "zh" ? "观察到" : "observed") : (language === "zh" ? "已确认" : "confirmed")}</small>
              </span>
              <b>{runtimeStatusText(agent.status, language)}</b>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
  const taskBoardPanel = activeTaskBoardWithRuntimeStatus || taskBoardMessage || taskBoardFallbackPrompt ? (
    <section className="task-board-panel" aria-label={language === "zh" ? "任务拆解工作台" : "Task decomposition board"}>
      <div className="task-board-head">
        <div>
          <span className="task-board-eyebrow">{language === "zh" ? "子 Agent 任务拆解" : "Sub-agent task board"}</span>
          <h3>{language === "zh" ? "任务拆解工作台" : "Task Board"}</h3>
          <p>{activeTaskBoardWithRuntimeStatus
            ? (language === "zh"
              ? `已拆解 ${activeTaskBoardWithRuntimeStatus.items.length} 个任务，已完成 ${activeTaskBoardSummary?.completed || 0} 个，模型 ${activeTaskBoardWithRuntimeStatus.model}`
              : `${activeTaskBoardWithRuntimeStatus.items.length} tasks, ${activeTaskBoardSummary?.completed || 0} completed with ${activeTaskBoardWithRuntimeStatus.model}`)
            : taskBoardMessage}</p>
        </div>
        <div className="task-board-actions">
          {activeTaskBoardWithRuntimeStatus ? (
            <>
              <button
                type="button"
                className="primary"
                onClick={() => void executeTaskBoard(activeTaskBoardWithRuntimeStatus)}
                disabled={taskBoardBusy || activeSessionBusy}
              >
                <Bot size={15} aria-hidden />
                {language === "zh" ? "继续执行剩余任务" : "Continue Remaining"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void executeOriginalPrompt(activeTaskBoardWithRuntimeStatus.sourcePrompt)}
                disabled={taskBoardBusy || activeSessionBusy}
              >
                {language === "zh" ? "直接执行原任务" : "Run Original"}
              </button>
            </>
          ) : taskBoardFallbackPrompt ? (
            <button
              type="button"
              className="secondary"
              onClick={() => void executeOriginalPrompt(taskBoardFallbackPrompt)}
              disabled={taskBoardBusy || activeSessionBusy}
            >
              {language === "zh" ? "直接执行原任务" : "Run Original"}
            </button>
          ) : null}
        </div>
      </div>
      {taskBoardMessage && activeTaskBoardWithRuntimeStatus ? (
        <p className="task-board-message">{taskBoardMessage}</p>
      ) : null}
      {activeTaskBoardWithRuntimeStatus?.warnings.length ? (
        <div className="task-board-warnings">
          {activeTaskBoardWithRuntimeStatus.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
      {activeTaskBoardWithRuntimeStatus ? (
        <div className="task-board-grid">
          {activeTaskBoardWithRuntimeStatus.items.map((item) => (
            <article key={item.id} className={`task-board-card status-${item.status}`}>
              <div className="task-board-card-top">
                <span className="task-board-role">{taskBoardRoleText(item.agentRole, language)}</span>
                <span className={`task-board-status status-${item.status}`}>{taskBoardStatusText(item.status, language)}</span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.goal}</p>
              <div className="task-board-meta">
                <span>{language === "zh" ? "依赖" : "Deps"}: {item.dependencies.length ? item.dependencies.join(", ") : "-"}</span>
                <span>{language === "zh" ? "范围" : "Areas"}: {item.targetAreas.join(", ")}</span>
              </div>
              {item.runtimeThreadId || item.runtimeTurnId || item.runId ? (
                <div className="task-board-runtime-meta">
                  {item.runId ? <code>run {item.runId}</code> : null}
                  {item.runtimeThreadId ? <code>thread {item.runtimeThreadId}</code> : null}
                  {item.runtimeTurnId ? <code>turn {item.runtimeTurnId}</code> : null}
                </div>
              ) : null}
              {item.outputSummary ? (
                <p className="task-board-output">
                  <strong>{language === "zh" ? "输出" : "Output"}</strong>
                  {item.outputSummary}
                </p>
              ) : null}
              {item.blockedReason ? (
                <p className="task-board-blocked">
                  <strong>{language === "zh" ? "阻塞" : "Blocked"}</strong>
                  {item.blockedReason}
                </p>
              ) : null}
              <ul>
                {item.acceptance.slice(0, 3).map((check) => <li key={check}>{check}</li>)}
              </ul>
              {(item.status === "failed" || item.status === "blocked") ? (
                <div className="task-board-card-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void executeTaskBoard(activeTaskBoardWithRuntimeStatus, item.id)}
                    disabled={taskBoardBusy || activeSessionBusy}
                  >
                    <RotateCcw size={14} aria-hidden />
                    {language === "zh" ? "重试此任务" : "Retry Task"}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  ) : null;
  const terminalPanel = (
    <section className={terminalCardClassName}>
      <div className="terminal-toolbar">
        <div className="status-line">
          <span className={`dot ${running ? "live" : ""}`} />
          <span className="terminal-title">
            <TerminalSquare size={15} aria-hidden />
            {t.terminal.streamTitle}
          </span>
          <small>{statusText} / {interactionLabel}</small>
        </div>
        <div className="quick-row terminal-actions">
          {activeSessionBusy ? (
            <button type="button" title={t.terminal.stop} onClick={stop}>
              <Square size={14} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            title={t.terminal.clear}
            onClick={() => {
              const sessionId = activeSessionIdRef.current;
              if (sessionId) {
                terminalRawOutputBySessionRef.current[sessionId] = "";
                terminalOutputBySessionRef.current[sessionId] = "";
              }
              renderTerminalForSession(sessionId);
            }}
          >
            <RotateCcw size={14} aria-hidden />
          </button>
        </div>
      </div>
      <div ref={terminalHostRef} className="terminal-host" />
      {shouldShowAgentRuntimeBoard ? agentRuntimeBoard : null}
    </section>
  );

  const skillsToolPage = (
    <section className="tool-editor-page">
      <section className={skillsRuntimeReady ? "runtime-toggle-card enabled" : "runtime-toggle-card"}>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.skillsEnabled}
            onChange={(event) => updateSetting("skillsEnabled", event.target.checked)}
          />
          <span>{t.skills.enableRuntime}</span>
        </label>
        <small>{t.skills.runtimeHint}</small>
      </section>
      <section className="template-editor compact-editor">
        <div className="template-editor-head">
          <div>
            <strong>{t.skills.createTitle}</strong>
            <small>{customization?.skillRoot || ""}</small>
          </div>
          <button type="button" className="secondary" onClick={importSkills}>
            <UploadCloud size={15} aria-hidden />
            {t.skills.importSkill}
          </button>
        </div>
        <label>
          {t.skills.createName}
          <input
            value={newSkillName}
            onChange={(event) => setNewSkillName(event.target.value)}
            placeholder={t.skills.createNamePlaceholder}
            spellCheck={false}
          />
        </label>
        <label>
          {t.skills.createDescription}
          <input
            value={newSkillDescription}
            onChange={(event) => setNewSkillDescription(event.target.value)}
            placeholder={t.skills.createDescriptionPlaceholder}
            spellCheck={false}
          />
        </label>
        <button type="button" className="primary wide" onClick={createSkill} disabled={!newSkillName.trim()}>
          <Plus size={16} aria-hidden />
          {t.skills.createSkill}
        </button>
      </section>
      {skillCatalog.map((skill) => {
        const enabled = settings.enabledSkills.includes(skill.id);
        const Icon = iconForSkill(skill);
        return (
          <button
            type="button"
            key={skill.id}
            className={enabled ? "preset-card enabled" : "preset-card"}
            onClick={() => toggleSkill(skill.id)}
          >
            <span className="preset-icon"><Icon size={18} aria-hidden /></span>
            <span>
              <strong>{skill.name}</strong>
              <small>{skill.description}</small>
              <span className="preset-meta">
                <b>{skill.category}</b>
                {skill.tools.map((tool) => <b key={tool}>{tool}</b>)}
              </span>
            </span>
            <span className={enabled ? "switch on" : "switch"} />
          </button>
        );
      })}
      {templateMessage ? <p className="template-message">{templateMessage}</p> : null}
      <div className="path-picker">
        <input
          value={settings.skillsDir}
          onChange={(event) => updateSetting("skillsDir", event.target.value)}
          placeholder={t.skills.customDirPlaceholder}
          spellCheck={false}
        />
        <button type="button" title={t.skills.chooseDir} onClick={chooseSkillsDir}>
          <FolderOpen size={16} aria-hidden />
        </button>
      </div>
      <button type="button" className="secondary wide" onClick={saveSettings}>
        {t.skills.save}
      </button>
    </section>
  );

  const mcpToolPage = (
    <section className="tool-editor-page mcp-config-page">
      <section className="mcp-setup-panel">
        <div className="template-editor-head">
          <div>
            <strong>{t.mcp.setupTitle}</strong>
            <small>{t.mcp.setupDesc}</small>
          </div>
          <button type="button" className="secondary" onClick={testMcpServers} disabled={mcpTesting}>
            <Activity size={16} aria-hidden />
            {mcpTesting ? t.mcp.testing : t.mcp.test}
          </button>
        </div>

        <div className="mcp-setup-search">
          <input
            ref={mcpSearchInputRef}
            value={mcpSearch}
            onChange={(event) => setMcpSearch(event.target.value)}
            placeholder={t.mcp.searchPlaceholder}
            spellCheck={false}
          />
        </div>

        <div className="category-row">
          {mcpCategories.map((category) => (
            <button
              type="button"
              key={category}
              className={mcpCategory === category ? "active" : ""}
              onClick={() => setMcpCategory(category)}
            >
              {t.category[category]}
            </button>
          ))}
        </div>

        <div className="mcp-summary-row">
          <span>{t.mcp.summaryEnabled(enabledMcpCount)}</span>
          <span>{t.mcp.injectable}: {mcpInjectableCount}</span>
          <span>{t.mcp.summaryVisible(filteredMcpPresets.length)}</span>
          <span>{t.mcp.summaryInstalled(mcpPresets.length)}</span>
        </div>

        {filteredMcpPresets.length === 0 ? (
          <div className="mcp-empty-setup">
            <Plug size={18} aria-hidden />
            <div>
              <strong>{t.mcp.setupEmptyTitle}</strong>
              <small>{t.mcp.setupEmptyBody}</small>
            </div>
            <span className="status-chip">{t.mcp.noMatches}</span>
          </div>
        ) : (
          <div className="mcp-setup-grid">
            {filteredMcpPresets.map((preset) => {
              const selected = settings.enabledMcpServers.includes(preset.id);
              const Icon = iconForMcp(preset.id);
              const presetText = getMcpText(preset, language);
              const setupRow = mcpSetupRows.find((row) => row.id === preset.id);
              const guide = mcpGuideForPreset(preset, language);
              const envKeys = setupRow?.envKeys.length ? setupRow.envKeys : mcpEnvKeysFromHint(presetText.envHint);
              const activeSecret = mcpSecretTarget?.presetId === preset.id;
              const cardClassName = selected
                ? setupRow?.injectable ? "mcp-setup-card ready" : "mcp-setup-card blocked"
                : "mcp-setup-card";
              const statusText = selected
                ? setupRow?.injectable ? t.mcp.injectable : setupRow?.statusText || t.mcp.untested
                : t.mcp.notSelected;
              return (
                <article key={preset.id} className={cardClassName}>
                  <button type="button" className="mcp-catalog-main" onClick={() => selectMcpForSetup(preset)}>
                    <span className="preset-icon"><Icon size={18} aria-hidden /></span>
                    <span>
                      <strong>{presetText.name}</strong>
                      <small>{presetText.description}</small>
                    </span>
                    <span className={selected ? setupRow?.injectable ? "status-chip enabled" : "status-chip warning" : "status-chip"}>
                      {statusText}
                    </span>
                  </button>
                  <p>{selected && setupRow?.hint ? setupRow.hint : presetText.envHint}</p>
                  <code>{setupRow?.command || preset.command}</code>
                  <div className="mcp-setup-actions">
                    {envKeys.length > 0 ? envKeys.map((key) => (
                      <button
                        type="button"
                        key={key}
                        className={activeSecret && mcpSecretKey === key ? "primary" : "secondary"}
                        onClick={() => {
                          if (!selected) void selectMcpForSetup(preset);
                          configureEnvKey(preset.id, key);
                        }}
                      >
                        <KeyRound size={15} aria-hidden />
                        {mcpSetupButtonLabel(preset.auth, key, language)}
                      </button>
                    )) : (
                      <button type="button" className={selected ? "secondary" : "primary"} onClick={() => selectMcpForSetup(preset)}>
                        <ShieldCheck size={15} aria-hidden />
                        {selected ? t.mcp.noAuthRequired : t.mcp.chooseService}
                      </button>
                    )}
                    {guide.url ? (
                      <button type="button" className="secondary" onClick={() => openMcpGuide(preset)}>
                        <Link2 size={15} aria-hidden />
                        {mcpGuideActionLabel(preset, language) || t.mcp.openGuide}
                      </button>
                    ) : null}
                  </div>
                  {activeSecret ? (
                    <div className="mcp-secret-form mcp-secret-inline">
                      <label>
                        {t.mcp.configureEnvKey(mcpSecretKey)}
                        <input
                          value={mcpSecretValue}
                          onChange={(event) => setMcpSecretValue(event.target.value)}
                          placeholder={mcpSecretPlaceholderForKey(mcpSecretKey, language)}
                          type="password"
                          spellCheck={false}
                        />
                      </label>
                      <button type="button" className="primary" onClick={saveMcpEnvSecret} disabled={mcpSecretSaving || !mcpSecretValue.trim()}>
                        <ShieldCheck size={16} aria-hidden />
                        {mcpSecretSaving ? t.mcp.testing : t.mcp.saveSecret}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className={mcpRuntimeReady ? "runtime-toggle-card enabled" : "runtime-toggle-card"}>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.mcpEnabled}
            onChange={(event) => updateSetting("mcpEnabled", event.target.checked)}
          />
          <span>{t.mcp.enableRuntime}</span>
        </label>
        <small>{settings.mcpEnabled ? (mcpRuntimeReady ? t.mcp.runtimeOn : t.mcp.runtimeBlocked) : t.mcp.runtimeOff}</small>
        <p>{t.mcp.runtimeHint}</p>
      </section>

      {settings.enabledMcpServers.length > 0 || mcpAdapterRows.length > 0 ? (
        <section className="mcp-adapter-panel">
          <div className="template-editor-head">
            <div>
              <strong>{t.mcp.adapterTitle}</strong>
              <small>{t.mcp.adapterDesc}</small>
            </div>
            <button type="button" className="secondary" onClick={testMcpServers} disabled={mcpTesting}>
              <Activity size={16} aria-hidden />
              {mcpTesting ? t.mcp.testing : t.mcp.test}
            </button>
          </div>
          <div className="mcp-adapter-list">
            {mcpAdapterRows.map((row) => (
              <article key={row.id} className={row.injectable ? "mcp-adapter-row ready" : "mcp-adapter-row blocked"}>
                <div>
                  <strong>{row.name}</strong>
                  <code>{row.command}</code>
                  <small>{row.hint}</small>
                </div>
                <div className="mcp-adapter-actions">
                  <span className={row.injectable ? "status-chip enabled" : "status-chip warning"}>{row.statusText}</span>
                  <span className={row.injectable ? "status-chip enabled" : "status-chip"}>{row.injectable ? t.mcp.injectable : t.mcp.notInjected}</span>
                  {row.guideUrl ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        const preset = mcpPresets.find((candidate) => candidate.id === row.id);
                        if (preset) void openMcpGuide(preset);
                      }}
                    >
                      <Link2 size={15} aria-hidden />
                      {t.mcp.guide}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {renderMcpTestSection(mcpTestServers)}

      <section className="template-editor custom-mcp-builder">
        <div className="template-editor-head">
          <div>
            <strong>{t.mcp.customTitle}</strong>
            <small>{t.mcp.customHint}</small>
          </div>
          <span className="status-chip">{t.mcp.sourceCustom}</span>
        </div>
        <div className="custom-mcp-grid">
          <label>
            {t.mcp.customId}
            <input
              value={customMcpId}
              onChange={(event) => setCustomMcpId(event.target.value)}
              placeholder={t.mcp.customIdPlaceholder}
              spellCheck={false}
            />
          </label>
          <label>
            {t.mcp.customCommand}
            <input
              value={customMcpCommand}
              onChange={(event) => setCustomMcpCommand(event.target.value)}
              placeholder={t.mcp.customCommandPlaceholder}
              spellCheck={false}
            />
          </label>
          <label className="wide-field">
            {t.mcp.customUrl}
            <input
              value={customMcpUrl}
              onChange={(event) => setCustomMcpUrl(event.target.value)}
              placeholder={t.mcp.customUrlPlaceholder}
              spellCheck={false}
            />
          </label>
          <label className="wide-field">
            {t.mcp.customArgs}
            <textarea
              value={customMcpArgs}
              onChange={(event) => setCustomMcpArgs(event.target.value)}
              placeholder={t.mcp.customArgsPlaceholder}
              spellCheck={false}
            />
          </label>
          <label className="wide-field">
            {t.mcp.customEnv}
            <textarea
              value={customMcpEnv}
              onChange={(event) => setCustomMcpEnv(event.target.value)}
              placeholder={t.mcp.customEnvPlaceholder}
              spellCheck={false}
            />
          </label>
        </div>
        <button type="button" className="primary wide" onClick={addCustomMcpServer}>
          <Plus size={16} aria-hidden />
          {t.mcp.addCustom}
        </button>
      </section>

      {templateMessage ? <p className="template-message">{templateMessage}</p> : null}
      <div className="path-picker">
        <input
          value={settings.mcpConfigPath}
          onChange={(event) => updateSetting("mcpConfigPath", event.target.value)}
          placeholder={t.mcp.customConfigPlaceholder}
          spellCheck={false}
        />
        <button type="button" title={t.mcp.chooseConfig} onClick={chooseMcpConfig}>
          <FileCog size={16} aria-hidden />
        </button>
      </div>
      <button type="button" className="secondary wide" onClick={saveSettings}>
        {t.mcp.save}
      </button>
    </section>
  );

  const scheduledTasksPage = (
    <section className="tool-editor-page scheduled-task-page automation-manager">
      <header className="automation-manager-head">
        <h1>{t.automations.helpTitle}</h1>
      </header>
      {automationMessage ? (
        <p className={automationMessageKind === "error" ? "template-message error" : "template-message"}>{automationMessage}</p>
      ) : null}

      {automationGroups.length === 0 ? (
        <p className="automation-empty">{t.automations.noTasks}</p>
      ) : (
        automationGroups.map((group) => (
          <section key={group.key} className="automation-list">
            <h2>{group.title}</h2>
            <div className="automation-rows">
              {group.tasks.map((task) => {
                const taskStatus = automationStatus(task);
                const schedule = automationSchedulePreview(createAutomationDraft(settings, task), language);
                const workspaceName = task.workspacePath ? projectNameFromWorkspace(task.workspacePath, language) : "";
                const idPreview = task.id.length > 18 ? `${task.id.slice(0, 18)}...` : task.id;
                const meta = [schedule, workspaceName || idPreview, workspaceName ? idPreview : ""].filter(Boolean).join(" · ");
                return (
                  <article key={task.id} className="automation-row">
                    <span className="automation-row-icon" aria-hidden>
                      <CalendarClock size={14} />
                    </span>
                    <div className="automation-row-main">
                      <strong title={task.name || task.prompt}>{task.name || defaultScheduledTaskName(task.prompt, language)}</strong>
                      <small title={[schedule, task.workspacePath, task.id].filter(Boolean).join(" · ")}>{meta}</small>
                      {task.error ? <small className="automation-row-error">{task.error}</small> : null}
                    </div>
                    <span className="automation-row-state">
                      {taskStatus === "ACTIVE" ? t.automations.installed : t.automations.draft}
                    </span>
                    <div className="automation-row-actions">
                      {taskStatus === "ACTIVE" ? (
                        <button type="button" title={t.automations.uninstall} onClick={() => uninstallAutomationTask(task)} disabled={automationBusy}>
                          <Square size={15} aria-hidden />
                        </button>
                      ) : (
                        <button type="button" title={t.automations.install} onClick={() => installAutomationTask(task)} disabled={automationBusy}>
                          <CalendarClock size={15} aria-hidden />
                        </button>
                      )}
                      <button type="button" className="danger" title={t.automations.delete} onClick={() => deleteAutomationTask(task)} disabled={automationBusy}>
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))
      )}
    </section>
  );

  const inspectorDrawerPanel =
    inspectorPanel === "remote" || inspectorPanel === "git" || inspectorPanel === "settings"
      ? inspectorPanel
      : null;

  return (
    <main className="app-shell">
      <aside className="conversation-sidebar">
        <section className="brand-row">
          <div className="brand-mark">
            <Bot size={21} aria-hidden />
          </div>
          <div>
            <h1>DeepSeek TUI</h1>
            <p>{t.sidebar.subtitle}</p>
          </div>
        </section>

        <button
          type="button"
          className="new-chat-button"
          title={selectedWorkspacePath.trim() ? t.sidebar.newChat : t.topbar.noWorkspace}
          onClick={newConversation}
          disabled={!selectedWorkspacePath.trim()}
        >
          <Plus size={17} aria-hidden />
          {t.sidebar.newChat}
        </button>

        <section className="history-scroll-shell">
          <button
            type="button"
            className="history-scroll-button top"
            title={historyScrollUpLabel}
            aria-label={historyScrollUpLabel}
            onClick={() => scrollHistory("up")}
            disabled={!historyScrollState.canScrollUp}
          >
            <ChevronUp size={15} aria-hidden />
          </button>
          <nav
            ref={historyScrollRef}
            className="history-tree history-scroll-pane"
            aria-label={t.sidebar.navLabel}
            onScroll={updateHistoryScrollState}
          >
            {conversationStore.projects.length === 0 ? (
              <p className="history-empty">{t.history.empty}</p>
            ) : null}
            {conversationStore.projects.map((project) => {
              const projectIsSelected = projectIdFromWorkspace(project.workspacePath) === selectedProjectId
                || project.sessions.some((session) => session.id === conversationStore.activeSessionId);
              const projectIsExpanded = expandedProjectIds.has(project.id);
              return (
              <section key={project.id} className={projectIsExpanded ? "project-group expanded" : "project-group collapsed"}>
                <div
                  className={[
                    "project-header",
                    projectIsSelected ? "active" : "",
                    projectIsExpanded ? "expanded" : ""
                  ].filter(Boolean).join(" ")}
                  title={project.workspacePath || project.name}
                >
                  <button
                    type="button"
                    className="project-select-button"
                    title={`${t.history.selectProject}: ${project.name}`}
                    aria-label={`${t.history.selectProject}: ${project.name}`}
                    aria-expanded={projectIsExpanded}
                    onClick={() => selectProject(project)}
                    disabled={!project.workspacePath.trim()}
                  >
                    <ChevronDown size={14} className="project-disclosure-icon" aria-hidden />
                    <FolderOpen size={15} aria-hidden />
                    <span>{project.name}</span>
                    <small>{project.sessions.length}</small>
                  </button>
                  <button
                    type="button"
                    className="project-new-chat-button"
                    title={t.history.newProjectSession}
                    aria-label={t.history.newProjectSession}
                    onClick={() => createProjectConversation(project.workspacePath)}
                    disabled={!project.workspacePath.trim()}
                  >
                    <Plus size={13} aria-hidden />
                  </button>
                </div>
                <div className="chat-list">
                  {projectIsExpanded ? project.sessions.map((session) => (
                    <div
                      key={session.id}
                      className={session.id === conversationStore.activeSessionId ? "chat-list-item active" : "chat-list-item"}
                    >
                      <button type="button" className="chat-list-main" onClick={() => selectConversation(session.id)}>
                        <MessageSquare size={16} aria-hidden />
                        <span>
                          <b>{session.title || t.history.untitled}</b>
                          <small>{formatSessionTime(session.updatedAt, language)}</small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="chat-delete-button"
                        title={t.history.deleteSession}
                        onClick={() => removeConversation(session.id)}
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  )) : null}
                </div>
              </section>
              );
            })}
          </nav>
          <button
            type="button"
            className="history-scroll-button bottom"
            title={historyScrollDownLabel}
            aria-label={historyScrollDownLabel}
            onClick={() => scrollHistory("down")}
            disabled={!historyScrollState.canScrollDown}
          >
            <ChevronDown size={15} aria-hidden />
          </button>
        </section>

        <div className="sidebar-spacer" />

        <section className="sidebar-actions">
          <button
            type="button"
            className={mainView === "tools" && toolPage === "skills" ? "sidebar-tool active" : "sidebar-tool"}
            onClick={() => openToolPage("skills")}
          >
            <BookOpen size={16} aria-hidden />
            Skills
            <span className="sidebar-badge">{enabledSkillCount}</span>
          </button>
          <button
            type="button"
            className={mainView === "tools" && toolPage === "mcp" ? "sidebar-tool active" : "sidebar-tool"}
            onClick={() => openToolPage("mcp")}
          >
            <Plug size={16} aria-hidden />
            MCP
            <span className="sidebar-badge">{enabledMcpCount}</span>
          </button>
          <button
            type="button"
            className={mainView === "tasks" ? "sidebar-tool active" : "sidebar-tool"}
            onClick={openScheduledTasksPage}
          >
            <CalendarClock size={16} aria-hidden />
            {t.sidebar.automations}
            <span className="sidebar-badge">{scheduledTaskSkillEnabled ? 1 : 0}</span>
          </button>
          <button
            type="button"
            className={inspectorPanel === "remote" ? "sidebar-tool active" : "sidebar-tool"}
            onClick={() => toggleInspectorPanel("remote")}
          >
            <Smartphone size={16} aria-hidden />
            {t.sidebar.remote}
          </button>
          <button
            type="button"
            className={inspectorPanel === "settings" ? "sidebar-tool active" : "sidebar-tool"}
            onClick={() => toggleInspectorPanel("settings")}
          >
            <Settings2 size={16} aria-hidden />
            {t.sidebar.settings}
          </button>
        </section>
      </aside>

      <section className="conversation-main">
        <header className="conversation-topbar">
          <div className="topbar-title">
            <h2>{activeSession?.title && activeSession.title !== t.history.untitled ? activeSession.title : t.topbar.title}</h2>
          </div>
          <div className="view-switch" aria-label={t.topbar.viewSwitch}>
            <button type="button" className={mainView === "chat" ? "active" : ""} onClick={() => setMainView("chat")}>
              <MessageSquare size={15} aria-hidden />
              {t.topbar.chat}
            </button>
	            <button type="button" className={mainView === "tools" ? "active" : ""} onClick={() => setMainView("tools")}>
	              <Layers3 size={15} aria-hidden />
	              {t.topbar.tools}
	            </button>
          </div>
          <div className="topbar-actions">
            {desktopUpdate ? (
              <button
                type="button"
                className="desktop-update-button"
                title={t.topbar.updateAvailable(desktopUpdate.version)}
                onClick={() => desktop.openExternal(desktopUpdate.downloadUrl || desktopUpdate.releaseUrl)}
              >
                <DownloadCloud size={16} aria-hidden />
                <span>{t.topbar.updateAvailable(desktopUpdate.version)}</span>
              </button>
            ) : null}
            {remoteStatus?.enabled && remoteStatus.running ? (
              <div className="runtime-pill ready">
                <Smartphone size={15} aria-hidden />
                <span>{`${t.remote.statusLabel} ${remoteStatus.port}`}</span>
              </div>
            ) : null}
            <button
              type="button"
              className={hasGlobalApiKey ? "api-key-global-button saved" : "api-key-global-button missing"}
              title={hasGlobalApiKey ? t.topbar.apiKeySaved : t.topbar.apiKeyMissing}
              onClick={() => setInspectorPanel("settings")}
            >
              <KeyRound size={16} aria-hidden />
              <span>{hasGlobalApiKey ? t.topbar.apiKeySaved : t.topbar.apiKeyMissing}</span>
            </button>
            <button
              type="button"
              className="secondary topbar-editor-button"
              title={t.topbar.openCursor}
              onClick={() => openWorkspaceEditor("cursor")}
              disabled={!settings.workspacePath.trim()}
            >
              <Code2 size={17} aria-hidden />
              <span>{t.topbar.openCursor}</span>
            </button>
          </div>
        </header>

        <div className={`conversation-body ${mainView === "chat" ? "chat-view" : ""}`}>
          <div className={mainView === "chat" ? conversationLayoutClassName : messageListClassName}>
	            <div className={mainView === "chat" ? "message-list chat-output-list" : "view-content"}>
	            {mainView === "chat" ? (
	              activeRuntimeThreadDetail && shouldShowRuntimeConversation ? (
	                <>
	                  <section className="runtime-context-bar">
	                    <div className="runtime-context-head">
	                      <div>
	                        <strong>{t.runtimeContext.title}</strong>
	                        <p>{t.runtimeContext.recallHint}</p>
	                      </div>
	                      <div className="message-inline-actions">
	                        <button
	                          type="button"
	                          className="secondary"
	                          onClick={pinContextAnchor}
	                          disabled={!contextAnchorDraft.trim()}
	                        >
	                          <Layers3 size={15} aria-hidden />
	                          <span>{t.runtimeContext.pin}</span>
	                        </button>
	                        <button
	                          type="button"
	                          className="secondary"
	                          onClick={() => void recallArchivedContext()}
	                          disabled={activeSessionBusy || !activeRuntimeContextHealth.recallAvailable}
	                        >
	                          <RotateCcw size={15} aria-hidden />
	                          <span>{t.runtimeContext.recall}</span>
	                        </button>
	                      </div>
	                    </div>
	                    <div className="runtime-anchor-list">
	                      {activeSessionAnchors.length > 0 ? activeSessionAnchors.map((anchor) => (
	                        <div key={anchor.id} className="runtime-anchor-chip">
	                          <span>{anchor.text}</span>
	                          <button type="button" onClick={() => removeContextAnchor(anchor.id)} aria-label="Remove anchor">
	                            <X size={13} aria-hidden />
	                          </button>
	                        </div>
	                      )) : (
	                        <p className="runtime-anchor-empty">{t.runtimeContext.noAnchors}</p>
	                      )}
	                    </div>
	                    <div className="runtime-context-chips">
	                      <span className={settings.layeredContextEnabled !== false ? "status-chip enabled" : "status-chip warning"}>
	                        {settings.layeredContextEnabled !== false ? t.runtimeContext.enabled : t.runtimeContext.disabled}
	                      </span>
	                      <span className="status-chip">
	                        {t.runtimeContext.recentTurns(settings.contextVerbatimWindowTurns)}
	                      </span>
	                      {activeRuntimeContextHealth.latestTurnStatus ? (
	                        <span
	                          className={
	                            activeRuntimeContextHealth.latestTurnStatus === "waiting_user_input"
	                              ? "status-chip warning"
	                              : activeRuntimeContextHealth.latestTurnStatus === "in_progress"
	                                ? "status-chip runtime-running"
	                                : activeRuntimeContextHealth.latestTurnStatus === "completed"
	                                  ? "status-chip enabled"
	                                  : "status-chip"
	                          }
	                        >
	                          {runtimeContextTurnStatusLabel(activeRuntimeContextHealth.latestTurnStatus, language)}
	                        </span>
	                      ) : null}
	                      {activeRuntimeContextHealth.seamCount > 0 ? (
	                        <span className="status-chip">{t.runtimeContext.seams(activeRuntimeContextHealth.seamCount)}</span>
	                      ) : null}
	                      {activeRuntimeContextHealth.compactionCount > 0 ? (
	                        <span className="status-chip warning">{t.runtimeContext.compactions(activeRuntimeContextHealth.compactionCount)}</span>
	                      ) : null}
	                      {activeRuntimeContextHealth.pendingApprovals > 0 ? (
	                        <span className="status-chip warning">{t.runtimeContext.approvals(activeRuntimeContextHealth.pendingApprovals)}</span>
	                      ) : null}
	                      {activeRuntimeContextHealth.pendingUserInputs > 0 ? (
	                        <span className="status-chip warning">{t.runtimeContext.questions(activeRuntimeContextHealth.pendingUserInputs)}</span>
	                      ) : null}
	                    </div>
	                  </section>
	                  {taskBoardPanel}
	                  {routingPanel}
	                  {activeRuntimeTimeline.mainEntries.map((entry) => {
	                  const item = entry.item as RuntimeApiItemRecord;
	                  const isUser = entry.kind === "user";
	                  const isRunning = item.status === "in_progress";
	                  const requestId = runtimeItemRequestId(item);
                  const requestQuestions = Array.isArray(item.metadata?.request?.questions)
                    ? item.metadata.request.questions as RuntimeApiUserInputQuestion[]
                    : [];
                  const selectedAnswers = runtimeUserInputDrafts[requestId] || {};
                  const answeredSummary = Array.isArray(item.metadata?.response?.answers)
                    ? (item.metadata.response.answers as RuntimeApiUserInputAnswer[]).map((answer) => answer.label).join(", ")
                    : "";
                  const inlineTitle = runtimeTimelineTitle(entry, language);
	                  return (
                    <article key={entry.id} className={`message-row ${isUser ? "user" : "assistant"} ${isRunning ? "running-reply" : ""}`}>
                      <div className="message-avatar">
                        {isUser ? (
                          <Code2 size={16} aria-hidden />
                        ) : item.kind === "approval_request" ? (
                          <ShieldCheck size={16} aria-hidden />
                        ) : item.kind === "user_input_request" ? (
                          <MessageSquare size={16} aria-hidden />
                        ) : item.kind === "tool_call" ? (
                          <TerminalSquare size={16} aria-hidden />
                        ) : item.kind === "error" ? (
                          <CircleAlert size={16} aria-hidden />
                        ) : isRunning ? (
                          <RunningActivityMark />
                        ) : (
                          <Bot size={16} aria-hidden />
                        )}
                      </div>
                      <div className={`message-bubble runtime-item-bubble runtime-item-${item.kind}`}>
                        {inlineTitle ? <strong>{inlineTitle}</strong> : null}
                        {isRunning ? <span className="running-label">{t.sidebar.running}</span> : null}
                        {item.detail || item.summary ? <p>{item.detail || item.summary}</p> : null}
                        {item.kind === "approval_request" && item.status === "in_progress" ? (
                          <div className="message-inline-actions">
                            <button type="button" className="secondary" onClick={() => void decideInlineApproval(item, "allow")}>
                              {language === "zh" ? "批准" : "Allow"}
                            </button>
                            <button type="button" className="secondary" onClick={() => void decideInlineApproval(item, "deny")}>
                              {language === "zh" ? "拒绝" : "Deny"}
                            </button>
                          </div>
                        ) : null}
                        {item.kind === "user_input_request" ? (
                          <div className="runtime-question-list">
                            {requestQuestions.map((question) => (
                              <div key={question.id} className="runtime-question-block">
                                <span className="runtime-question-header">{question.header}</span>
                                <p>{question.question}</p>
                                <div className="message-inline-actions">
                                  {question.options.map((option) => {
                                    const active = selectedAnswers[question.id] === option.label;
                                    return (
                                      <button
                                        key={option.label}
                                        type="button"
                                        className={active ? "secondary active-chip" : "secondary"}
                                        onClick={() => selectRuntimeUserInputOption(requestId, question.id, option.label)}
                                        disabled={item.status === "completed"}
                                      >
                                        {option.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                            {item.status !== "completed" ? (
                              <div className="message-inline-actions">
                                <button type="button" className="secondary" onClick={() => void submitRuntimeUserInput(item)}>
                                  {language === "zh" ? "继续执行" : "Continue"}
                                </button>
                              </div>
                            ) : answeredSummary ? (
                              <p className="runtime-answer-summary">
                                {language === "zh" ? `已选择：${answeredSummary}` : `Selected: ${answeredSummary}`}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
		                  );
		                })}
	                  {(activeRuntimeTimeline.actions.length > 0 || activeRuntimeTimeline.toolCalls.length > 0) ? (
	                    <details className="runtime-detail-group">
	                      <summary>
	                        <TerminalSquare size={15} aria-hidden />
	                        <span>{language === "zh" ? "执行细节" : "Run details"}</span>
	                        <small>{activeRuntimeTimeline.actions.length + activeRuntimeTimeline.toolCalls.length}</small>
	                      </summary>
	                      <div className="runtime-detail-list">
	                        {[...activeRuntimeTimeline.actions, ...activeRuntimeTimeline.toolCalls].map((entry) => (
	                          <article key={`detail-${entry.id}`}>
	                            <strong>{runtimeTimelineTitle(entry, language)}</strong>
	                            <p>{entry.text || entry.sourceKind}</p>
	                          </article>
	                        ))}
	                      </div>
	                    </details>
	                  ) : null}
		                </>
		              ) : (
		                <>
		                  {taskBoardPanel}
		                  {routingPanel}
		                  {messages.map((message) => {
                  const isRunningReply = message.role === "assistant" && activeSessionRunningReplyIds.has(message.id);
                  return (
                  <article key={message.id} className={`message-row ${message.role} ${isRunningReply ? "running-reply" : ""}`}>
                    <div className="message-avatar">
                      {message.role === "assistant"
                        ? isRunningReply ? <RunningActivityMark /> : <Bot size={16} aria-hidden />
                        : <Code2 size={16} aria-hidden />}
                    </div>
                    <div className="message-bubble">
                      {message.title ? <strong>{message.title}</strong> : null}
                      {isRunningReply ? (
                        <span className="running-label">
                          {t.sidebar.running}
                        </span>
                      ) : null}
                      <p>{message.content}</p>
                    </div>
                  </article>
                  );
                })}
		                </>
		              )
            ) : null}

            {mainView === "tools" ? (
              <section className="tool-dashboard">
                <div className="tool-page-tabs" aria-label={t.topbar.tools}>
                  <button type="button" className={toolPage === "overview" ? "active" : ""} onClick={() => setToolPage("overview")}>
                    <Layers3 size={15} aria-hidden />
                    {t.topbar.tools}
                  </button>
                  <button type="button" className={toolPage === "mcp" ? "active" : ""} onClick={() => setToolPage("mcp")}>
                    <Plug size={15} aria-hidden />
                    MCP
                  </button>
                  <button type="button" className={toolPage === "skills" ? "active" : ""} onClick={() => setToolPage("skills")}>
                    <BookOpen size={15} aria-hidden />
                    Skills
                  </button>
                </div>

                {toolPage === "overview" ? (
                  <>
                <div className="dashboard-grid">
                  <article className="metric-card">
                    <Plug size={20} aria-hidden />
                    <strong>{enabledMcpCount}</strong>
                    <span>{t.tools.enabledMcp}</span>
                  </article>
                  <article className="metric-card">
                    <BookOpen size={20} aria-hidden />
                    <strong>{enabledSkillCount}</strong>
                    <span>{t.tools.enabledSkills}</span>
                  </article>
                  <article className="metric-card">
                    <ShieldCheck size={20} aria-hidden />
                    <strong>{mcpPresets.length}</strong>
                    <span>{t.tools.installablePresets}</span>
                  </article>
                </div>

                {runtimeApiPanel}

                <div className="tool-section-head">
                  <div>
                    <h3>{t.tools.mcpStatus}</h3>
                    <p>{t.tools.mcpStatusDesc}</p>
                  </div>
                  <button type="button" className="secondary" onClick={() => setToolPage("mcp")}>
                    <SlidersHorizontal size={16} aria-hidden />
                    {t.tools.manageMcp}
                  </button>
                </div>

                <div className="tool-grid">
                  {mcpPresets.map((preset) => {
                    const enabled = settings.enabledMcpServers.includes(preset.id);
                    const Icon = iconForMcp(preset.id);
                    const presetText = getMcpText(preset, language);
                    return (
                      <article
                        key={preset.id}
                        className={enabled ? `tool-card enabled ${preset.accent}` : `tool-card ${preset.accent}`}
                      >
                        <div className="tool-card-top">
                          <span className="preset-icon"><Icon size={18} aria-hidden /></span>
                          <span className={enabled ? "status-chip enabled" : "status-chip"}>{enabled ? t.tools.selected : t.tools.off}</span>
                        </div>
                        <strong>{presetText.name}</strong>
                        <p>{presetText.description}</p>
                        <div className="tool-meta">
                          <span>{t.category[preset.category]}</span>
                          <span>{formatDownloads(preset.downloads, language)}</span>
                          <span>{t.auth[preset.auth]}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>

                <div className="tool-section-head">
                  <div>
                    <h3>Skills</h3>
                    <p>{t.tools.skillsDesc}</p>
                  </div>
                  <button type="button" className="secondary" onClick={() => setToolPage("skills")}>
                    <BookOpen size={16} aria-hidden />
                    {t.tools.manageSkills}
                  </button>
                </div>

                <div className="skill-grid">
                  {skillCatalog.map((skill) => {
                    const enabled = settings.enabledSkills.includes(skill.id);
                    const Icon = iconForSkill(skill);
                    return (
                      <article
                        key={skill.id}
                        className={enabled ? "skill-card enabled" : "skill-card"}
                      >
                        <span className="preset-icon"><Icon size={18} aria-hidden /></span>
                        <strong>{skill.name}</strong>
                        <p>{skill.description}</p>
                        <div className="tool-meta">
                          <span>{skill.category}</span>
                          {skill.tools.map((tool) => <span key={tool}>{tool}</span>)}
                        </div>
                      </article>
                    );
                  })}
                </div>
                  </>
                ) : null}

                {toolPage === "skills" ? skillsToolPage : null}
                {toolPage === "mcp" ? mcpToolPage : null}
              </section>
	            ) : null}
	            {mainView === "tasks" ? scheduledTasksPage : null}
		            </div>
            {mainView === "chat" && processStreamEnabled ? terminalPanel : null}
          </div>
        </div>

        <footer className="composer">
          <div className="composer-actions">
            <div className="agent-mode-switch" aria-label={t.composer.modeLabel}>
              <button type="button" className={permissionMode === "plan" ? "active" : ""} onClick={() => setPermissionMode("plan")}>
                <Brain size={15} aria-hidden />
                Plan
              </button>
              <button type="button" className={permissionMode === "agent" ? "active" : ""} onClick={() => setPermissionMode("agent")}>
                <Bot size={15} aria-hidden />
                Agent
              </button>
              <button type="button" className={permissionMode === "yolo" ? "active" : ""} onClick={() => setPermissionMode("yolo")}>
                <Zap size={15} aria-hidden />
                YOLO
              </button>
            </div>
            <button
              type="button"
              className={gitStatus?.isRepo ? "branch-status-button" : "branch-status-button missing"}
              title={`${t.topbar.currentBranch}: ${currentBranchLabel}`}
              onClick={() => setInspectorPanel("git")}
              disabled={!settings.workspacePath.trim()}
            >
              <GitBranch size={16} aria-hidden />
              <span>{currentBranchLabel}</span>
            </button>
            <button
              type="button"
              className="workspace-picker-button"
              title={selectedWorkspacePath ? `${t.topbar.chooseWorkspace}: ${selectedWorkspacePath}` : t.topbar.chooseWorkspace}
              onClick={chooseWorkspace}
            >
              <FolderOpen size={15} aria-hidden />
              <span>{selectedWorkspaceLabel}</span>
            </button>
            <label className="model-picker">
              <span>{t.composer.modelLabel}</span>
              <span className="select-wrap">
                <select
                  value={primaryModelPresets.some((preset) => preset.value === settings.model)
                    ? settings.model
                    : DEFAULT_DEEPSEEK_MODEL}
                  onChange={(event) => updateModel(event.target.value)}
                >
                  {primaryModelPresets.map((preset) => (
                    <option key={preset.value} value={preset.value}>{preset.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden />
              </span>
            </label>
          </div>
          <div className={`interaction-state-bar ${interactionState.severity} phase-${interactionState.phase}`} role="status">
            <span>
              <span className="interaction-state-dot" aria-hidden />
              <strong>{interactionLabel}</strong>
            </span>
            <small>{interactionDetail}</small>
          </div>
          <div className={interactionBlocksNewPrompt ? "composer-input interaction-blocked" : "composer-input"}>
            <textarea
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={permissionMode === "plan"
                  ? t.composer.planPlaceholder
                  : permissionMode === "yolo"
                    ? t.composer.yoloPlaceholder
                    : t.composer.execPlaceholder}
              rows={2}
            />
            {composerCanStop ? (
              <button type="button" className="send-button stop-button" title={t.composer.stop} onClick={stop}>
                <Square size={18} aria-hidden />
              </button>
            ) : (
              <button type="button" className="send-button" onClick={() => void sendPrompt()} disabled={!composerCanSubmit}>
                <Send size={18} aria-hidden />
              </button>
            )}
          </div>
        </footer>
      </section>

      {inspectorDrawerPanel ? (
        <>
        <button
          type="button"
          className="inspector-scrim"
          aria-label={t.inspector.close}
          onClick={() => setInspectorPanel(null)}
        />
        <aside className="inspector-panel">
          <div className="inspector-header">
            <div>
              <h3>{t.inspector.titles[inspectorDrawerPanel]}</h3>
              <p>{t.inspector.subtitles[inspectorDrawerPanel]}</p>
            </div>
            <button type="button" className="icon-button" title={t.inspector.close} onClick={() => setInspectorPanel(null)}>
              <X size={17} aria-hidden />
            </button>
          </div>

          {inspectorPanel === "skills" ? (
            <div className="inspector-content">
              <section className={skillsRuntimeReady ? "runtime-toggle-card enabled" : "runtime-toggle-card"}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.skillsEnabled}
                    onChange={(event) => updateSetting("skillsEnabled", event.target.checked)}
                  />
                  <span>{t.skills.enableRuntime}</span>
                </label>
                <small>{t.skills.runtimeHint}</small>
              </section>
              <section className="template-editor compact-editor">
                <div className="template-editor-head">
                  <div>
                    <strong>{t.skills.createTitle}</strong>
                    <small>{customization?.skillRoot || ""}</small>
                  </div>
                  <button type="button" className="secondary" onClick={importSkills}>
                    <UploadCloud size={15} aria-hidden />
                    {t.skills.importSkill}
                  </button>
                </div>
                <label>
                  {t.skills.createName}
                  <input
                    value={newSkillName}
                    onChange={(event) => setNewSkillName(event.target.value)}
                    placeholder={t.skills.createNamePlaceholder}
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t.skills.createDescription}
                  <input
                    value={newSkillDescription}
                    onChange={(event) => setNewSkillDescription(event.target.value)}
                    placeholder={t.skills.createDescriptionPlaceholder}
                    spellCheck={false}
                  />
                </label>
                <button type="button" className="primary wide" onClick={createSkill} disabled={!newSkillName.trim()}>
                  <Plus size={16} aria-hidden />
                  {t.skills.createSkill}
                </button>
              </section>
              {skillCatalog.map((skill) => {
                const enabled = settings.enabledSkills.includes(skill.id);
                const Icon = iconForSkill(skill);
                return (
                  <button
                    type="button"
                    key={skill.id}
                    className={enabled ? "preset-card enabled" : "preset-card"}
                    onClick={() => toggleSkill(skill.id)}
                  >
                    <span className="preset-icon"><Icon size={18} aria-hidden /></span>
                    <span>
                      <strong>{skill.name}</strong>
                      <small>{skill.description}</small>
                      <span className="preset-meta">
                        <b>{skill.category}</b>
                        {skill.tools.map((tool) => <b key={tool}>{tool}</b>)}
                      </span>
                    </span>
                    <span className={enabled ? "switch on" : "switch"} />
                  </button>
                );
              })}
              {templateMessage ? <p className="template-message">{templateMessage}</p> : null}
              <div className="path-picker">
                <input
                  value={settings.skillsDir}
                  onChange={(event) => updateSetting("skillsDir", event.target.value)}
                  placeholder={t.skills.customDirPlaceholder}
                  spellCheck={false}
                />
                <button type="button" title={t.skills.chooseDir} onClick={chooseSkillsDir}>
                  <FolderOpen size={16} aria-hidden />
                </button>
              </div>
              <button type="button" className="secondary wide" onClick={saveSettings}>
                {t.skills.save}
              </button>
            </div>
          ) : null}

          {false ? (
            <div className="inspector-content">
              <div className="tool-help">
                <BookOpen size={17} aria-hidden />
                <div>
                  <strong>{t.mcp.helpTitle}</strong>
                  <p>{t.mcp.helpBody}</p>
                </div>
              </div>

              <section className={mcpRuntimeReady ? "runtime-toggle-card enabled" : "runtime-toggle-card"}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.mcpEnabled}
                    onChange={(event) => updateSetting("mcpEnabled", event.target.checked)}
                  />
                  <span>{t.mcp.enableRuntime}</span>
                </label>
                <small>{settings.mcpEnabled ? (mcpRuntimeReady ? t.mcp.runtimeOn : t.mcp.runtimePending) : t.mcp.runtimeOff}</small>
                <p>{t.mcp.runtimeHint}</p>
              </section>

              <input
                value={mcpSearch}
                onChange={(event) => setMcpSearch(event.target.value)}
                placeholder={t.mcp.searchPlaceholder}
                spellCheck={false}
              />

              <div className="category-row">
                {mcpCategories.map((category) => (
                  <button
                    type="button"
                    key={category}
                    className={mcpCategory === category ? "active" : ""}
                    onClick={() => setMcpCategory(category)}
                  >
                    {t.category[category]}
                  </button>
                ))}
              </div>

              <div className="mcp-summary-row">
                <span>{t.mcp.summaryEnabled(enabledMcpCount)}</span>
                <span>{t.mcp.injectable}: {mcpInjectableCount}</span>
                <span>{t.mcp.summaryVisible(filteredMcpPresets.length)}</span>
                <span>{t.mcp.summaryInstalled(mcpPresets.length)}</span>
              </div>

              <button type="button" className="secondary wide" onClick={testMcpServers} disabled={mcpTesting}>
                <Activity size={16} aria-hidden />
                {mcpTesting ? t.mcp.testing : t.mcp.test}
              </button>

              {renderMcpTestSection(mcpTestServers)}

              {filteredMcpPresets.map((preset) => {
                const enabled = settings.enabledMcpServers.includes(preset.id);
                const Icon = iconForMcp(preset.id);
                const presetText = getMcpText(preset, language);
                return (
                  <button
                    type="button"
                    key={preset.id}
                    className={enabled ? `preset-card enabled ${preset.accent}` : `preset-card ${preset.accent}`}
                    onClick={() => toggleMcp(preset.id)}
                  >
                    <span className="preset-icon"><Icon size={18} aria-hidden /></span>
                    <span>
                      <strong>{presetText.name}</strong>
                      <small>{presetText.description}</small>
                      <code>{preset.command}</code>
                      <em>{presetText.envHint}</em>
                      <span className="preset-meta">
                        <b>{t.category[preset.category]}</b>
                        <b>{formatDownloads(preset.downloads, language)}</b>
                        <b>{t.safety[preset.safety]} {t.mcp.riskSuffix}</b>
                      </span>
                    </span>
                    <span className={enabled ? "switch on" : "switch"} />
                  </button>
                );
              })}
              {templateMessage ? <p className="template-message">{templateMessage}</p> : null}
              <div className="path-picker">
                <input
                  value={settings.mcpConfigPath}
                  onChange={(event) => updateSetting("mcpConfigPath", event.target.value)}
                  placeholder={t.mcp.customConfigPlaceholder}
                  spellCheck={false}
                />
                <button type="button" title={t.mcp.chooseConfig} onClick={chooseMcpConfig}>
                  <FileCog size={16} aria-hidden />
                </button>
              </div>
              <button type="button" className="secondary wide" onClick={saveSettings}>
                {t.mcp.save}
              </button>
            </div>
          ) : null}

          {inspectorPanel === "git" ? (
            <div className="inspector-content">
              <section className={gitStatus?.isRepo ? "git-summary" : "git-summary warning"}>
                <div>
                  {gitStatus?.isRepo ? <CheckCircle2 size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />}
                  <strong>{gitStatus?.isRepo ? t.git.repoReady : t.git.notRepoTitle}</strong>
                </div>
                <small>{gitStatus?.isRepo ? gitStatusSummary(gitStatus, language) : t.git.notRepoBody}</small>
              </section>

              <div className="remote-actions">
                <button type="button" className="secondary" onClick={refreshGitStatus} disabled={gitBusy}>
                  <RefreshCw size={16} aria-hidden />
                  {t.git.refresh}
                </button>
                <button type="button" className="primary" onClick={initGitRepository} disabled={gitBusy || gitStatus?.isRepo}>
                  <GitBranch size={16} aria-hidden />
                  {t.git.init}
                </button>
              </div>

              {gitStatus?.isRepo ? (
                <>
                  <section className="git-meta-grid">
                    <div>
                      <span>{t.git.branch}</span>
                      <strong>{gitStatus.branch || "main"}</strong>
                    </div>
                    <div>
                      <span>{t.git.upstream}</span>
                      <strong>{gitStatus.upstream || t.git.noRemote}</strong>
                    </div>
                    <div>
                      <span>{t.git.repoRoot}</span>
                      <strong title={gitStatus.repoRoot}>{gitStatus.repoRoot}</strong>
                    </div>
                    <div>
                      <span>{t.git.lastCommit}</span>
                      <strong>{gitStatus.lastCommit ? `${gitStatus.lastCommit.hash} ${gitStatus.lastCommit.subject}` : t.git.noCommit}</strong>
                    </div>
                  </section>

                  <div className="mcp-summary-row">
                    <span>{t.git.aheadBehind(gitStatus.ahead, gitStatus.behind)}</span>
                    <span>{t.git.staged} {gitStatus.staged}</span>
                    <span>{t.git.unstaged} {gitStatus.unstaged}</span>
                    <span>{t.git.untracked} {gitStatus.untracked}</span>
                  </div>

                  <label className="branch-select-row">
                    {t.git.switchBranch}
                    <span className="select-wrap">
                      <select
                        value={gitStatus.branch}
                        onChange={(event) => switchGitBranch(event.target.value)}
                        disabled={gitBusy || gitStatus.hasChanges}
                      >
                        {gitStatus.branches.map((branch) => (
                          <option key={`${branch.type}:${branch.name}`} value={branch.name}>
                            {branch.name} · {branch.type === "remote" ? t.git.remoteBranch : t.git.localBranch}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} aria-hidden />
                    </span>
                    {gitStatus.hasChanges ? <small>{t.git.dirtyBranchBlocked}</small> : null}
                  </label>

                  <label>
                    {t.git.remote}
                    <input
                      value={gitRemoteUrl}
                      onChange={(event) => setGitRemoteUrl(event.target.value)}
                      placeholder={t.git.remotePlaceholder}
                      spellCheck={false}
                    />
                  </label>
                  <div className="remote-actions">
                    <button type="button" className="primary" onClick={saveGitRemote} disabled={gitBusy || !gitRemoteUrl.trim()}>
                      <Link2 size={16} aria-hidden />
                      {t.git.saveRemote}
                    </button>
                    <button type="button" className="secondary" onClick={copyGitRemote} disabled={gitBusy || !gitRemoteUrl.trim()}>
                      <Copy size={16} aria-hidden />
                      {t.git.copyRemote}
                    </button>
                  </div>

                  <div className="git-actions">
                    <button type="button" className="secondary" onClick={() => runGitRepositoryAction("fetch")} disabled={gitBusy || !gitStatus.originUrl}>
                      <RefreshCw size={16} aria-hidden />
                      {t.git.fetch}
                    </button>
                    <button type="button" className="secondary" onClick={() => runGitRepositoryAction("pull")} disabled={gitBusy || !gitStatus.upstream}>
                      <DownloadCloud size={16} aria-hidden />
                      {t.git.pull}
                    </button>
                    <button type="button" className="secondary" onClick={() => runGitRepositoryAction("push")} disabled={gitBusy || !gitStatus.originUrl}>
                      <UploadCloud size={16} aria-hidden />
                      {t.git.push}
                    </button>
                  </div>

                  <label>
                    {t.git.commitMessage}
                    <input
                      value={gitCommitMessage}
                      onChange={(event) => setGitCommitMessage(event.target.value)}
                      placeholder={t.git.commitPlaceholder}
                      spellCheck={false}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary wide"
                    onClick={previewGitDiffSummary}
                    disabled={gitDiffBusy || !gitStatus.hasChanges}
                  >
                    <FileCog size={16} aria-hidden />
                    {t.git.preview}
                  </button>
                  {gitDiffSummary ? (
                    <section className="git-diff-preview">
                      <strong>{t.git.previewTitle}</strong>
                      <pre>{gitDiffSummary}</pre>
                    </section>
                  ) : null}
                  <button
                    type="button"
                    className="primary wide"
                    onClick={commitGitRepository}
                    disabled={gitBusy || !gitStatus.hasChanges || !gitCommitMessage.trim()}
                  >
                    <GitCommitHorizontal size={16} aria-hidden />
                    {t.git.commit}
                  </button>

                  <section className="git-change-list">
                    <div>
                      <strong>{t.git.changes}</strong>
                      <small>{gitStatus.hasChanges ? gitStatusSummary(gitStatus, language) : t.git.noChanges}</small>
                    </div>
                    {gitStatus.changes.length === 0 ? <p>{t.git.noChanges}</p> : null}
                    {gitStatus.changes.slice(0, 50).map((change, index) => (
                      <div key={`${change.status}-${change.path}-${index}`} className="git-change-row">
                        <span>{gitStatusLabel(change)}</span>
                        <code title={change.path}>{change.path}</code>
                      </div>
                    ))}
                  </section>
                </>
              ) : null}

              {gitMessage ? <p className={gitMessageKind === "error" ? "template-message error" : "template-message"}>{gitMessage}</p> : null}
            </div>
          ) : null}

          {inspectorPanel === "remote" ? (
            <div className="inspector-content">
              <section className="remote-summary">
                <div>
                  <UserRound size={15} aria-hidden />
                  <strong>{remoteStatus?.auth.account?.displayName || remoteStatus?.auth.account?.accountId || t.remote.accountLoggedOut}</strong>
                </div>
                <small>{remoteStatus?.auth.desktopId || ""}</small>
              </section>

              <label>
                {t.remote.accountTitle}
                <input
                  value={loginAccount}
                  onChange={(event) => setLoginAccount(event.target.value)}
                  placeholder={t.remote.accountPlaceholder}
                  spellCheck={false}
                />
              </label>
              <input
                value={loginDisplayName}
                onChange={(event) => setLoginDisplayName(event.target.value)}
                placeholder={t.remote.displayNamePlaceholder}
                spellCheck={false}
              />
              <div className="remote-actions">
                <button type="button" className="primary" onClick={loginRemoteAccount}>
                  <UserRound size={16} aria-hidden />
                  {t.remote.login}
                </button>
                <button type="button" className="secondary" onClick={logoutRemoteAccount} disabled={!remoteStatus?.auth.loggedIn}>
                  <LogOut size={16} aria-hidden />
                  {t.remote.logout}
                </button>
              </div>

              <section className="remote-summary">
                <div>
                  <Link2 size={15} aria-hidden />
                  <strong>{t.remote.pairTitle}</strong>
                </div>
                <small>{t.remote.pairHint}</small>
              </section>
              {pairingCode || remoteStatus?.auth.pairing ? (
                <div className="pairing-code">
                  <span>{t.remote.pairingCode}</span>
                  <strong>{pairingCode || remoteStatus?.auth.pairing?.codePreview}</strong>
                  <small>{t.remote.pairingExpires}: {remoteStatus?.auth.pairing?.expiresAt || ""}</small>
                </div>
              ) : null}
              <button type="button" className="secondary wide" onClick={startRemotePairing} disabled={!remoteStatus?.auth.loggedIn}>
                <Link2 size={16} aria-hidden />
                {t.remote.startPairing}
              </button>

              <section className="device-list">
                <strong>{t.remote.pairedDevices}</strong>
                {(remoteStatus?.auth.devices || []).length === 0 ? (
                  <small>{t.remote.noDevices}</small>
                ) : null}
                {(remoteStatus?.auth.devices || []).map((device) => (
                  <div key={device.id} className="device-row">
                    <span>
                      <b>{device.name}</b>
                      <small>{device.platform} · {device.lastSeenAt || device.pairedAt}</small>
                    </span>
                    <button type="button" title={t.remote.revokeDevice} onClick={() => revokeRemoteDevice(device.id)}>
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </div>
                ))}
              </section>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.mobileBridgeEnabled}
                  onChange={(event) => updateSetting("mobileBridgeEnabled", event.target.checked)}
                />
                <span>{t.remote.enableMobile}</span>
              </label>

              <div className="two-col remote-grid">
                <label>
                  Host
                  <span className="select-wrap">
                    <select
                      value={settings.mobileBridgeHost}
                      onChange={(event) => updateSetting("mobileBridgeHost", event.target.value)}
                    >
                      <option value="127.0.0.1">127.0.0.1</option>
                      <option value="0.0.0.0">0.0.0.0 / LAN</option>
                    </select>
                    <ChevronDown size={14} aria-hidden />
                  </span>
                </label>
                <label>
                  Port
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={settings.mobileBridgePort}
                    onChange={(event) => updateSetting("mobileBridgePort", Number(event.target.value))}
                  />
                </label>
              </div>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.mobileRemoteControlEnabled}
                  onChange={(event) => updateSetting("mobileRemoteControlEnabled", event.target.checked)}
                />
                <span>{t.remote.allowControl}</span>
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.updatePushEnabled}
                  onChange={(event) => updateSetting("updatePushEnabled", event.target.checked)}
                />
                <span>{t.remote.allowUpdates}</span>
              </label>

              <section className="remote-summary">
                <div>
                  <span className={`dot ${remoteStatus?.running ? "live" : ""}`} />
                  <strong>{remoteStatus?.running ? t.remote.bridgeRunning : t.remote.bridgeStopped}</strong>
                </div>
                <small>{remoteStatus?.error || t.remote.tokenRequired}</small>
              </section>

              <section className="remote-summary warning">
                <div>
                  <CircleAlert size={15} aria-hidden />
                  <strong>{t.remote.connectionAddress}</strong>
                </div>
                <small>{t.remote.localBridgeNote}</small>
              </section>

              <div className="copy-row">
                <label>{t.remote.connectionAddress}</label>
                <input value={remoteStatus?.lanUrl || ""} readOnly spellCheck={false} />
                <button type="button" title={t.remote.copyLanUrl} onClick={() => copyRemoteText(remoteStatus?.lanUrl || "", t.remote.connectionAddress)}>
                  <Copy size={15} aria-hidden />
                </button>
              </div>
              <div className="copy-row">
                <label>{t.remote.accessKey}</label>
                <input value={remoteStatus?.token || settings.mobileBridgeToken || ""} readOnly spellCheck={false} />
                <button type="button" title={t.remote.copyToken} onClick={() => copyRemoteText(remoteStatus?.token || settings.mobileBridgeToken, t.remote.accessKey)}>
                  <Copy size={15} aria-hidden />
                </button>
              </div>

              <div className="endpoint-list">
                <code>GET /api/v1/status</code>
                <code>POST /api/v1/auth/login</code>
                <code>POST /api/v1/auth/pair</code>
                <code>GET /api/v1/events</code>
                <code>POST /api/v1/session/start</code>
                <code>POST /api/v1/terminal/input</code>
                <code>POST /api/v1/skills/upsert</code>
                <code>POST /api/v1/updates/push</code>
              </div>

              {remoteStatus?.lastUpdateNotice ? (
                <section className="remote-summary">
                  <div>
                    <Bell size={15} aria-hidden />
                    <strong>{remoteStatus.lastUpdateNotice.title}</strong>
                  </div>
                  <small>{remoteStatus.lastUpdateNotice.body}</small>
                </section>
              ) : null}

              {remoteMessage ? <p className="remote-message">{remoteMessage}</p> : null}

              <button type="button" className="primary wide" onClick={saveSettings}>
                <ShieldCheck size={16} aria-hidden />
                {t.remote.saveApply}
              </button>
              <div className="remote-actions">
                <button type="button" className="secondary" onClick={restartRemoteBridge}>
                  <RefreshCw size={16} aria-hidden />
                  {t.remote.restart}
                </button>
                <button type="button" className="secondary" onClick={rotateRemoteToken}>
                  <KeyRound size={16} aria-hidden />
                  {t.remote.rotateToken}
                </button>
              </div>
              <button type="button" className="secondary wide" onClick={pushTestUpdateNotice}>
                <Bell size={16} aria-hidden />
                {t.remote.testUpdate}
              </button>
            </div>
          ) : null}

          {inspectorPanel === "settings" ? (
            <div className="inspector-content">
              <section className="language-settings">
                <div>
                  <strong>{t.settings.language}</strong>
                  <small>{t.settings.languageHint}</small>
                </div>
                <div className="language-switch" aria-label={t.settings.language}>
                  <button
                    type="button"
                    className={language === "zh" ? "active" : ""}
                    onClick={() => switchLanguage("zh")}
                  >
                    <Globe2 size={15} aria-hidden />
                    {t.settings.chinese}
                  </button>
                  <button
                    type="button"
                    className={language === "en" ? "active" : ""}
                    onClick={() => switchLanguage("en")}
                  >
                    <Globe2 size={15} aria-hidden />
                    {t.settings.english}
                  </button>
                </div>
              </section>
              <label>
                Workspace
                <div className="path-picker">
                  <input
                    value={settings.workspacePath}
                    onChange={(event) => updateSetting("workspacePath", event.target.value)}
                    placeholder="/path/to/project"
                    spellCheck={false}
                  />
                  <button type="button" title={t.settings.chooseWorkspace} onClick={chooseWorkspace}>
                    <FolderOpen size={16} aria-hidden />
                  </button>
                </div>
              </label>
              <div className="editor-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => openWorkspaceEditor("cursor")}
                  disabled={!settings.workspacePath.trim()}
                >
                  <Code2 size={16} aria-hidden />
                  {t.settings.openCursor}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => openWorkspaceEditor("vscode")}
                  disabled={!settings.workspacePath.trim()}
                >
                  <TerminalSquare size={16} aria-hidden />
                  {t.settings.openVSCode}
                </button>
              </div>
              <label>
                {t.settings.model}
                <span className="select-wrap">
                  <select
                    value={primaryModelPresets.some((preset) => preset.value === settings.model)
                      ? settings.model
                      : DEFAULT_DEEPSEEK_MODEL}
                    onChange={(event) => updateModel(event.target.value)}
                    disabled={settings.provider !== "deepseek"}
                  >
                    {primaryModelPresets.map((preset) => (
                      <option key={preset.value} value={preset.value}>{preset.label}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} aria-hidden />
                </span>
              </label>
              <label className="global-api-key-field">
                {t.settings.apiKey}
                <div className="input-icon">
                  <KeyRound size={15} aria-hidden />
                  <input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    type="password"
                    placeholder={settings.provider === "nvidia-nim" ? t.settings.nvidiaKeyPlaceholder : t.settings.deepseekKeyPlaceholder}
                    spellCheck={false}
                  />
                </div>
                <small className="field-hint">{t.settings.apiKeyHint}</small>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={processStreamEnabled}
                  onChange={(event) => updateSetting("processStreamEnabled", event.target.checked)}
                />
                <span>{t.settings.processStream}</span>
              </label>
              <small className="field-hint">{t.settings.processStreamHint}</small>
              <label>
                {t.settings.thinkingMode}
                <span className="select-wrap">
                  <select
                    value={normalizeDeepSeekThinkingMode(settings.thinkingMode)}
                    onChange={(event) => updateSetting("thinkingMode", normalizeDeepSeekThinkingMode(event.target.value))}
                    disabled={settings.provider !== "deepseek"}
                  >
                    <option value="max">Max</option>
                    <option value="high">High</option>
                    <option value="off">Off</option>
                  </select>
                  <ChevronDown size={14} aria-hidden />
                </span>
              </label>
              <small className="field-hint">{t.settings.thinkingModeHint}</small>
              <label>
                {t.settings.skillRoutingMode}
                <span className="select-wrap">
                  <select
                    value={settings.skillRoutingMode}
                    onChange={(event) => updateSetting("skillRoutingMode", event.target.value as SkillRoutingMode)}
                  >
                    <option value="auto">Auto</option>
                    <option value="manual">Manual</option>
                    <option value="all">All</option>
                  </select>
                  <ChevronDown size={14} aria-hidden />
                </span>
              </label>
              <small className="field-hint">{t.settings.skillRoutingModeHint}</small>
              <label>
                {t.settings.modelRoutingMode}
                <span className="select-wrap">
                  <select
                    value={settings.modelRoutingMode}
                    onChange={(event) => updateSetting("modelRoutingMode", event.target.value as ModelRoutingMode)}
                  >
                    <option value="auto">Auto</option>
                    <option value="manual">Manual</option>
                  </select>
                  <ChevronDown size={14} aria-hidden />
                </span>
              </label>
              <small className="field-hint">{t.settings.modelRoutingModeHint}</small>
              <details className="advanced-settings">
                <summary>
                  <span>{t.settings.advancedRuntime}</span>
                  <small>{t.settings.advancedRuntimeHint}</small>
                </summary>
                <label>
                  {language === "zh" ? "运行环境" : "Runtime"}
                  <span className="select-wrap">
                    <select
                      value={settings.binaryMode}
                      onChange={async (event) => {
                        const value = event.target.value as BinaryMode;
                        updateSetting("binaryMode", value);
                        await refreshRuntime({ binaryMode: value });
                      }}
                    >
                      <option value="bundled">Bundled</option>
                      <option value="system">System PATH</option>
                      <option value="custom">Custom</option>
                    </select>
                    <ChevronDown size={14} aria-hidden />
                  </span>
                </label>
                <div className="path-picker">
                  <input
                    value={settings.customBinaryPath}
                    onChange={(event) => updateSetting("customBinaryPath", event.target.value)}
                    placeholder={t.settings.customDeepseekPath}
                    spellCheck={false}
                  />
                  <button type="button" title={t.settings.chooseBinary} onClick={chooseCustomBinary}>
                    <TerminalSquare size={16} aria-hidden />
                  </button>
                </div>
                <label>
                  {t.settings.provider}
                  <span className="select-wrap">
                    <select
                      value={settings.provider}
                      onChange={(event) => updateProvider(event.target.value as ProviderMode)}
                    >
                      <option value="deepseek">DeepSeek</option>
                      <option value="nvidia-nim">NVIDIA NIM</option>
                    </select>
                    <ChevronDown size={14} aria-hidden />
                  </span>
                </label>
                <label>
                  {t.settings.advancedModel}
                  <span className="select-wrap">
                    <select
                      value={selectedModelPreset?.value || settings.model}
                      onChange={(event) => updateModel(event.target.value)}
                      disabled={settings.provider !== "deepseek"}
                    >
                      {modelPresets.map((preset) => (
                        <option key={preset.value} value={preset.value}>{preset.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={14} aria-hidden />
                  </span>
                </label>
                {selectedModelPreset ? (
                  <a className="model-doc-row" href={selectedModelPreset.docsUrl} target="_blank" rel="noreferrer">
                    <BookOpen size={15} aria-hidden />
                    <span>{selectedModelDocsLabel}</span>
                    <code>{t.settings.apiModel(selectedModelApiName)}</code>
                  </a>
                ) : null}
                {settings.provider === "deepseek" ? (
                  <section className="endpoint-selector">
                    <div className="field-label">{t.settings.endpoint}</div>
                    <div className="endpoint-segmented">
                      <button
                        type="button"
                        className={deepSeekEndpointMode === "stable" ? "active" : ""}
                        onClick={() => updateDeepSeekEndpointMode("stable")}
                      >
                        {t.settings.endpointStable}
                      </button>
                      <button
                        type="button"
                        className={deepSeekEndpointMode === "beta" ? "active" : ""}
                        onClick={() => updateDeepSeekEndpointMode("beta")}
                      >
                        {t.settings.endpointBeta}
                      </button>
                      <button
                        type="button"
                        className={deepSeekEndpointMode === "custom" ? "active" : ""}
                        onClick={() => updateDeepSeekEndpointMode("custom")}
                      >
                        {t.settings.endpointCustom}
                      </button>
                    </div>
                    {deepSeekEndpointMode === "custom" ? (
                      <input
                        value={settings.baseUrl}
                        onChange={(event) => updateSetting("baseUrl", event.target.value)}
                        placeholder={DEEPSEEK_BASE_URL}
                        spellCheck={false}
                      />
                    ) : (
                      <code className="endpoint-url-preview">{settings.baseUrl || DEEPSEEK_BASE_URL}</code>
                    )}
                    <small className="field-hint">{t.settings.endpointHint}</small>
                  </section>
                ) : (
                  <label>
                    {t.settings.baseUrl}
                    <input
                      value={settings.baseUrl}
                      onChange={(event) => updateSetting("baseUrl", event.target.value)}
                      placeholder={defaultBaseUrlForProvider(settings.provider)}
                      spellCheck={false}
                    />
                  </label>
	                )}
	                <label className="check-row">
	                  <input
	                    type="checkbox"
	                    checked={settings.layeredContextEnabled !== false}
	                    onChange={(event) => updateSetting("layeredContextEnabled", event.target.checked)}
	                  />
	                  <span>{t.settings.layeredContext}</span>
	                </label>
	                <small className="field-hint">{t.settings.layeredContextHint}</small>
	                <label>
	                  {t.settings.contextVerbatimWindowTurns}
	                  <input
	                    type="number"
	                    min={4}
	                    max={64}
	                    value={settings.contextVerbatimWindowTurns}
	                    onChange={(event) => updateSetting(
	                      "contextVerbatimWindowTurns",
	                      normalizeContextVerbatimWindowTurns(Number(event.target.value))
	                    )}
	                    disabled={settings.layeredContextEnabled === false}
	                  />
	                </label>
	                <small className="field-hint">{t.settings.contextVerbatimWindowTurnsHint}</small>
	                <div className="two-col">
	                  <label className="check-row">
	                    <input
                      type="checkbox"
                      checked={settings.allowShell}
                      onChange={(event) => updateSetting("allowShell", event.target.checked)}
                    />
                    <span>{t.settings.allowShell}</span>
                  </label>
                  <label>
                    {t.settings.agents}
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={settings.maxSubagents}
                      onChange={(event) => updateSetting("maxSubagents", Number(event.target.value))}
                    />
                  </label>
                </div>
              </details>
              <button type="button" className="primary wide" onClick={saveSettings}>
                {t.settings.save}
              </button>
            </div>
          ) : null}
        </aside>
        </>
      ) : null}
    </main>
  );
}

export default App;
