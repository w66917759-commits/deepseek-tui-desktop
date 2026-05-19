const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DeepSeekRuntimeState } = require("./runtimeState.cjs");

const DEFAULT_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
].join(path.delimiter);
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEFAULT_ENABLED_SKILLS = ["superpowers", "ui-ux-pro-max", "scheduled-task-agent", "cron-scheduler", "skill-downloader"];
const PREVIOUS_DEFAULT_ENABLED_SKILLS = ["superpowers", "ui-ux-pro-max", "cron-scheduler", "skill-downloader"];
const LEGACY_DEFAULT_SKILLS = ["superpowers", "ui-ux-design"];
const DEFAULT_MAX_SUBAGENTS = 10;
const LEGACY_DESKTOP_MAX_SUBAGENTS = 3;
const DESKTOP_MANAGED_CONFIG_FILE = "deepseek.desktop.managed.toml";
const SKILL_PRESET_VERSION = 5;
const AUTOMATION_STORE_VERSION = 1;
const AUTOMATION_CRON_BEGIN = "# BEGIN DeepSeek TUI Desktop automation";
const AUTOMATION_CRON_END = "# END DeepSeek TUI Desktop automation";
const DESKTOP_AUTOMATION_MCP_ID = "desktop-automation";
const SKILL_CONTENT_MAX_CHARS = 120000;
const SKILL_ID_MAX_CHARS = 72;
const CRON_ALIASES = new Set(["@reboot", "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);
const GIT_COMMAND_TIMEOUT = 30000;
const SECRET_STORE_VERSION = 1;
const DEEPSEEK_API_MODELS = new Map([
  ["deepseek-v4-pro", "deepseek-v4-pro"],
  ["deepseek-v4-pro-1m", "deepseek-v4-pro"],
  ["deepseek-v4-flash", "deepseek-v4-flash"],
  ["deepseek-v4-flash-1m", "deepseek-v4-flash"],
  ["deepseek-chat", "deepseek-v4-flash"],
  ["deepseek-reasoner", "deepseek-v4-flash"]
]);

function desktopPath(env = process.env) {
  return env.PATH ? `${DEFAULT_PATH}${path.delimiter}${env.PATH}` : DEFAULT_PATH;
}

function desktopEnv(env = process.env) {
  return {
    ...env,
    PATH: desktopPath(env)
  };
}

const CRON_SCHEDULER_SKILL_CONTENT = [
  "---",
  "name: cron-scheduler",
  "description: Advanced-only helper for hand-authored crontab files. Normal scheduled tasks are handled by the Scheduled Task Agent Skill.",
  "---",
  "",
  "# Cron Advanced Scripts",
  "",
  "Use this skill only when the user explicitly asks for a raw cron file or crontab snippet. For normal recurring Agent tasks, use the Scheduled Task Agent Skill instead of telling the Agent to create a cron file first.",
  "",
  "## Guardrails",
  "",
  "- Treat this as an advanced escape hatch, not the default scheduled-task workflow.",
  "- Generate and validate a cron file before discussing installation.",
  "- Do not run `crontab`, overwrite an existing crontab, or install a task unless the user explicitly asks.",
  "- If the schedule, command, workspace, or timezone is ambiguous, ask only for the missing field.",
  "- Prefer workspace-local outputs under `.deepseek/cron/` and logs under `.deepseek/logs/`.",
  "- Use five-field cron syntax unless the user explicitly asks for a cron alias such as `@daily`.",
  "",
  "## Workflow",
  "",
  "1. Normalize the request into: task name, cron expression, command, working directory, timezone, and optional env vars.",
  "2. Run the bundled helper from the active skills directory:",
  "",
  "```bash",
  "node \"$DEEPSEEK_SKILLS_DIR/cron-scheduler/scripts/write-cron-file.mjs\" \\",
  "  --name \"daily-health-check\" \\",
  "  --schedule \"0 5 * * *\" \\",
  "  --command \"npm run health:check\" \\",
  "  --cwd \"$PWD\" \\",
  "  --timezone \"Asia/Shanghai\"",
  "```",
  "",
  "3. Inspect the generated cron file and verify the path exists.",
  "4. Report the generated file path, schedule, command, log path, and whether installation was skipped.",
  "",
  "## Installation Handling",
  "",
  "If the user explicitly asks to install it, first inspect `crontab -l`. Merge the new entry with existing entries instead of replacing the user's crontab blindly."
].join("\n");

const SCHEDULED_TASK_AGENT_SKILL_CONTENT = [
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
  "5. If the tool reports a credential or runtime problem, tell the user the exact missing piece instead of writing a separate cron file.",
  "",
  "## Response Style",
  "",
  "- Do not over-explain unavailable internals.",
  "- If more information is needed, ask concise clarifying questions.",
  "- If enough information is present, produce the schedule artifact or exact next command."
].join("\n");

const SKILL_DOWNLOADER_SKILL_CONTENT = [
  "---",
  "name: skill-downloader",
  "description: Use when the user asks to download, install, import, fetch, or update a Skill from a URL, GitHub raw file, local path, or archive.",
  "---",
  "",
  "# Skill Downloader",
  "",
  "Use this skill when a user asks to download or install a Skill during a desktop Agent conversation.",
  "",
  "## Guardrails",
  "",
  "- Do not synthesize remote Skill content. Download or copy the source bytes first, then verify the saved file.",
  "- Only install from an explicit URL, GitHub raw URL, local directory, local `SKILL.md`, or archive path supplied by the user or by a trusted project file.",
  "- Prefer workspace-local installs under `.deepseek/skills/<skill-id>/SKILL.md` unless the user explicitly asks to install into the shared runtime skills directory.",
  "- If installing into the shared runtime directory, use `$DEEPSEEK_SKILLS_DIR/<skill-id>/SKILL.md` and create the parent directory first.",
  "- Never write API keys, tokens, or private repository credentials into a Skill file.",
  "",
  "## URL Download Workflow",
  "",
  "1. Normalize the target Skill id from the source or user request.",
  "2. Create the destination directory.",
  "3. Download the exact remote response with curl:",
  "",
  "```bash",
  "mkdir -p \".deepseek/skills/<skill-id>\"",
  "curl -fsSL \"<skill-url>\" -o \".deepseek/skills/<skill-id>/SKILL.md\"",
  "```",
  "",
  "4. Verify the result:",
  "",
  "```bash",
  "test -s \".deepseek/skills/<skill-id>/SKILL.md\"",
  "sed -n '1,40p' \".deepseek/skills/<skill-id>/SKILL.md\"",
  "```",
  "",
  "5. Confirm the file is a real Skill, ideally with YAML frontmatter containing `name:` and `description:`.",
  "6. Report the source URL, destination path, and verification result.",
  "",
  "## Local Directory Workflow",
  "",
  "If the source is a local directory, find `SKILL.md`, copy the containing directory to the destination, then verify the copied `SKILL.md`. Preserve support files such as `scripts/`, `templates/`, and `examples/`."
].join("\n");

const LEGACY_SUPERPOWERS_SKILL_CONTENT = [
  "# Superpowers",
  "",
  "Use this skill to strengthen planning, task decomposition, code editing, verification, and final reporting.",
  "",
  "- Start by identifying the user's concrete goal and the workspace scope.",
  "- Prefer small, reversible edits that match the existing codebase.",
  "- Verify changes with the narrowest useful command before reporting completion.",
  "- Surface blockers, assumptions, and residual risk clearly."
].join("\n");

const SUPERPOWERS_SKILL_CONTENT = [
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
].join("\n");

const LEGACY_UI_UX_DESIGN_SKILL_CONTENT = [
  "# UI/UX Design",
  "",
  "Use this skill for product UI work, desktop app polish, and visual interaction checks.",
  "",
  "- Keep primary workflows visible and reduce default configuration clutter.",
  "- Use familiar controls: icon buttons for tools, toggles for binary settings, and compact panels for advanced options.",
  "- Check spacing, overflow, text fit, empty states, disabled states, and responsive constraints.",
  "- Prefer restrained, work-focused surfaces for developer tools."
].join("\n");

const UI_UX_DESIGN_SKILL_CONTENT = [
  "---",
  "name: ui-ux-pro-max",
  "description: Use when designing, building, or refining frontend UI/UX: layouts, components, visual systems, typography, color, and UX patterns.",
  "---",
  "",
  "# UI/UX Pro Max - Design Intelligence",
  "",
  "This fallback is used only when the packaged UI/UX Pro Max directory is unavailable. The normal preset is imported from `electron/skills/ui-ux-pro-max` with its `scripts/` and `data/` support files.",
  "",
  "## Product Principles",
  "",
  "- Prioritize the user's active workflow over configuration density.",
  "- Use familiar controls: icon buttons for tools, toggles for binary settings, inputs for values, menus for option sets, and compact panels for advanced flows.",
  "- Developer tools should be quiet, work-focused, and scannable; avoid marketing layouts, decorative cards, and oversized headings.",
  "- Keep advanced configuration hidden until the user opens the relevant tool page.",
  "",
  "## State Clarity",
  "",
  "- Do not collapse different states into one label. Separate selected, saved, injected, authenticated, connected, callable, failed, and disabled.",
  "- For MCP and other external tools, show blocked states near the action that would otherwise imply availability.",
  "- A missing credential, placeholder URL, invalid URL, or missing command should read as blocked and should explain the exact missing piece.",
  "- Keep status chips short and pair them with concise helper text when the consequence matters.",
  "",
  "## Visual QA",
  "",
  "- Check spacing, overflow, text fit, empty states, disabled states, hover/focus states, and narrow-window behavior.",
  "- Stable tool rows and cards should not resize unpredictably when warnings or long paths appear.",
  "- Verify visible UI after code changes with a browser or app preview when available."
].join("\n");

const PRESET_SKILLS = {
  superpowers: {
    dir: "superpowers",
    name: "Superpowers",
    content: SUPERPOWERS_SKILL_CONTENT,
    sourceDir: path.join("skills", "superpowers"),
    legacyContent: [LEGACY_SUPERPOWERS_SKILL_CONTENT, SUPERPOWERS_SKILL_CONTENT]
  },
  "ui-ux-pro-max": {
    dir: "ui-ux-pro-max",
    name: "UI/UX Pro Max",
    content: UI_UX_DESIGN_SKILL_CONTENT,
    sourceDir: path.join("skills", "ui-ux-pro-max"),
    legacyDirs: ["ui-ux-design"],
    legacyContent: [LEGACY_UI_UX_DESIGN_SKILL_CONTENT, UI_UX_DESIGN_SKILL_CONTENT]
  },
  "cron-scheduler": {
    dir: "cron-scheduler",
    name: "Cron Scheduler",
    content: CRON_SCHEDULER_SKILL_CONTENT,
    files: [
      {
        source: path.join("skills", "cron-scheduler", "scripts", "write-cron-file.mjs"),
        target: path.join("scripts", "write-cron-file.mjs"),
        executable: true
      }
    ]
  },
  "scheduled-task-agent": {
    dir: "scheduled-task-agent",
    name: "Scheduled Task Agent",
    content: SCHEDULED_TASK_AGENT_SKILL_CONTENT
  },
  "skill-downloader": {
    dir: "skill-downloader",
    name: "Skill Downloader",
    content: SKILL_DOWNLOADER_SKILL_CONTENT
  }
};

const MCP_PRESETS = {
  playwright: {
    command: "npx",
    args: ["-y", "@playwright/mcp"],
    env() {
      return {};
    }
  },
  context7: {
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    env() {
      return {};
    }
  },
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env() {
      return {
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN || ""
      };
    }
  },
  memory: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env() {
      return {};
    }
  },
  "sequential-thinking": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    env() {
      return {};
    }
  },
  postgres: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", process.env.POSTGRES_CONNECTION_STRING || "postgresql://localhost/postgres"],
    env() {
      return {
        POSTGRES_CONNECTION_STRING: process.env.POSTGRES_CONNECTION_STRING || ""
      };
    }
  },
  puppeteer: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    env() {
      return {};
    }
  },
  "brave-search": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env() {
      return {
        BRAVE_API_KEY: process.env.BRAVE_API_KEY || ""
      };
    }
  },
  slack: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env() {
      return {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || "",
        SLACK_TEAM_ID: process.env.SLACK_TEAM_ID || ""
      };
    }
  },
  notion: {
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env() {
      return {
        NOTION_TOKEN: process.env.NOTION_TOKEN || process.env.NOTION_API_TOKEN || ""
      };
    }
  },
  sentry: {
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    env() {
      return {
        SENTRY_ACCESS_TOKEN: process.env.SENTRY_ACCESS_TOKEN || "",
        SENTRY_HOST: process.env.SENTRY_HOST || "sentry.io",
        SENTRY_URL: process.env.SENTRY_URL || ""
      };
    }
  },
  stripe: {
    command: "npx",
    args: ["-y", "@stripe/mcp"],
    env() {
      return {
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || ""
      };
    }
  },
  figma: {
    command: "npx",
    args: ["-y", "figma-developer-mcp"],
    env() {
      return {
        FIGMA_API_KEY: process.env.FIGMA_API_KEY || process.env.FIGMA_ACCESS_TOKEN || ""
      };
    }
  },
  "google-maps": {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    env() {
      return {
        GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || ""
      };
    }
  },
  "mcp-remote": {
    command: "npx",
    args: ["-y", "mcp-remote", process.env.MCP_REMOTE_URL || "https://example.com/mcp"],
    env() {
      return {
        MCP_REMOTE_URL: process.env.MCP_REMOTE_URL || ""
      };
    }
  },
  pannel: {
    command: "mcp-1panel",
    args: [],
    env() {
      return {
        PANEL_HOST: process.env.PANEL_HOST || process.env["1PANEL_BASE_URL"] || "",
        PANEL_ACCESS_TOKEN: process.env.PANEL_ACCESS_TOKEN || process.env["1PANEL_API_KEY"] || ""
      };
    }
  },
  filesystem: {
    command: "npx",
    args(workspacePath) {
      return ["-y", "@modelcontextprotocol/server-filesystem", workspacePath];
    },
    env() {
      return {};
    }
  }
};

function defaultSettings() {
  return {
    language: "zh",
    workspacePath: os.homedir(),
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
    maxSubagents: DEFAULT_MAX_SUBAGENTS,
    processStreamEnabled: true,
    thinkingMode: "max",
    skillRoutingMode: "auto",
    modelRoutingMode: "auto",
    harnessEnabled: false,
    launchAction: "tui",
    rememberWorkspace: true,
    enabledSkills: [...DEFAULT_ENABLED_SKILLS],
    enabledMcpServers: [],
    mobileBridgeEnabled: false,
    mobileBridgeHost: "127.0.0.1",
    mobileBridgePort: 8765,
    mobileBridgeToken: "",
    mobileRemoteControlEnabled: false,
    updatePushEnabled: false
  };
}

function defaultBaseUrlForProvider(provider) {
  return provider === "nvidia-nim" ? NVIDIA_NIM_BASE_URL : DEEPSEEK_BASE_URL;
}

function normalizeDeepSeekModelSelection(model) {
  const value = String(model || "").trim();
  return DEEPSEEK_API_MODELS.has(value) ? value : DEFAULT_DEEPSEEK_MODEL;
}

function apiModelForProvider(provider, model) {
  if (normalizeProvider(provider) === "nvidia-nim") {
    return trimString(model || DEFAULT_DEEPSEEK_MODEL, 120);
  }
  return DEEPSEEK_API_MODELS.get(String(model || "").trim()) || DEFAULT_DEEPSEEK_MODEL;
}

function normalizeSettings(settings) {
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
    layeredContextEnabled: settings.layeredContextEnabled !== false,
    contextVerbatimWindowTurns: normalizeContextVerbatimWindowTurns(settings.contextVerbatimWindowTurns)
  };
}

function binaryName(base) {
  return process.platform === "win32" ? `${base}.exe` : base;
}

function unpackAsar(binaryPath) {
  return binaryPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function resolveBundledResourcePath(candidatePath) {
  const candidate = path.resolve(candidatePath || "");
  const unpackedCandidate = unpackAsar(candidate);
  if (unpackedCandidate !== candidate && fs.existsSync(unpackedCandidate)) {
    return unpackedCandidate;
  }
  return candidate;
}

function findOnPath(command) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
    env: desktopEnv()
  });
  if (result.status === 0) {
    return result.stdout.split(/\r?\n/).find(Boolean) || "";
  }
  return "";
}

function runtimeVersion(binaryPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return "";
  }
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    env: desktopEnv(),
    timeout: 5000
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return output.split(/\r?\n/)[0] || "";
}

function normalizeWorkspace(workspacePath) {
  if (workspacePath && fs.existsSync(workspacePath)) {
    const stat = fs.statSync(workspacePath);
    if (stat.isDirectory()) {
      return path.resolve(workspacePath);
    }
  }
  return os.homedir();
}

function sanitizeSettings(settings) {
  const safeSettings = normalizeSettings({ ...defaultSettings(), ...settings });
  delete safeSettings.apiKey;
  delete safeSettings.agentPrompt;
  delete safeSettings.cols;
  delete safeSettings.rows;
  safeSettings.mobileBridgeEnabled = Boolean(safeSettings.mobileBridgeEnabled);
  safeSettings.skillsEnabled = safeSettings.skillsEnabled !== false;
  safeSettings.mcpEnabled = Boolean(safeSettings.mcpEnabled);
  safeSettings.processStreamEnabled = safeSettings.processStreamEnabled ?? true;
  safeSettings.processStreamEnabled = safeSettings.processStreamEnabled !== false;
  safeSettings.thinkingMode = normalizeDeepSeekThinkingMode(safeSettings.thinkingMode);
  safeSettings.skillRoutingMode = ["auto", "manual", "all"].includes(safeSettings.skillRoutingMode) ? safeSettings.skillRoutingMode : "auto";
  safeSettings.modelRoutingMode = safeSettings.modelRoutingMode === "manual" ? "manual" : "auto";
  safeSettings.mobileRemoteControlEnabled = Boolean(safeSettings.mobileRemoteControlEnabled);
  safeSettings.updatePushEnabled = Boolean(safeSettings.updatePushEnabled);
  safeSettings.layeredContextEnabled = safeSettings.layeredContextEnabled !== false;
  safeSettings.contextVerbatimWindowTurns = normalizeContextVerbatimWindowTurns(
    safeSettings.contextVerbatimWindowTurns
  );
  safeSettings.mobileBridgeHost = typeof safeSettings.mobileBridgeHost === "string" && safeSettings.mobileBridgeHost.trim()
    ? safeSettings.mobileBridgeHost.trim()
    : "127.0.0.1";
  const bridgePort = Number(safeSettings.mobileBridgePort);
  safeSettings.mobileBridgePort = Number.isInteger(bridgePort) && bridgePort >= 1024 && bridgePort <= 65535
    ? bridgePort
    : 8765;
  if (typeof safeSettings.mobileBridgeToken !== "string" || safeSettings.mobileBridgeToken.length < 20) {
    safeSettings.mobileBridgeToken = createRemoteToken();
  }
  safeSettings.maxSubagents = normalizeMaxSubagents(settings?.maxSubagents);
  safeSettings.enabledSkills = normalizeEnabledSkills(safeSettings);
  safeSettings.harnessEnabled = false;
  safeSettings.skillPresetVersion = SKILL_PRESET_VERSION;
  return safeSettings;
}

function normalizeMaxSubagents(value) {
  const number = Number(value);
  return !Number.isFinite(number) || number === LEGACY_DESKTOP_MAX_SUBAGENTS
    ? DEFAULT_MAX_SUBAGENTS
    : number;
}

function normalizeDeepSeekThinkingMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "high" || mode === "off" || mode === "max" ? mode : "max";
}

function normalizeContextVerbatimWindowTurns(value) {
  const turns = Number(value);
  if (!Number.isInteger(turns)) return 16;
  return Math.min(64, Math.max(4, turns));
}

function desktopProcessReasoningEffort(settings) {
  if (settings?.processStreamEnabled === false) return "off";
  return normalizeDeepSeekThinkingMode(settings?.thinkingMode);
}

function enabledList(values) {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
}

function sameSkillSelection(left, right) {
  return left.length === right.length && right.every((id) => left.includes(id));
}

function mcpFeatureArgs(options = {}) {
  if (options.desktopAutomationMcpReady) {
    return ["--enable", "mcp"];
  }
  if (typeof options.runtimeMcpReady === "boolean") {
    return options.mcpEnabled && options.runtimeMcpReady ? ["--enable", "mcp"] : [];
  }
  const runtimeMcpServerIds = Array.isArray(options.runtimeMcpServerIds)
    ? enabledList(options.runtimeMcpServerIds)
    : enabledList(options.enabledMcpServers);
  const hasPresetConfig = runtimeMcpServerIds.length > 0;
  const hasCustomConfig = Boolean(String(options.mcpConfigPath || "").trim());
  return options.mcpEnabled && (hasPresetConfig || hasCustomConfig) ? ["--enable", "mcp"] : [];
}

function normalizeEnabledSkills(settings) {
  if (!Array.isArray(settings.enabledSkills)) {
    return [...DEFAULT_ENABLED_SKILLS];
  }

  const selected = enabledList(settings.enabledSkills);
  const skillPresetVersion = Number(settings.skillPresetVersion) || 0;
  const shouldRunSkillMigration = skillPresetVersion < SKILL_PRESET_VERSION;
  const selectedWithRenamedPresets = shouldRunSkillMigration
    ? selected.map((id) => id === "ui-ux-design" ? "ui-ux-pro-max" : id)
    : selected;
  const stillOnOldDefaults = shouldRunSkillMigration
    && selected.length === LEGACY_DEFAULT_SKILLS.length
    && LEGACY_DEFAULT_SKILLS.every((id) => selected.includes(id));
  const oldDefaultsWithCron = shouldRunSkillMigration
    && selected.length === LEGACY_DEFAULT_SKILLS.length + 1
    && LEGACY_DEFAULT_SKILLS.every((id) => selected.includes(id))
    && selected.includes("cron-scheduler");
  const previousDesktopDefaults = shouldRunSkillMigration
    && sameSkillSelection(selectedWithRenamedPresets, PREVIOUS_DEFAULT_ENABLED_SKILLS);

  const normalized = stillOnOldDefaults || oldDefaultsWithCron || previousDesktopDefaults ? [...DEFAULT_ENABLED_SKILLS] : selectedWithRenamedPresets;

  return normalized.filter((id) => id !== "harness-probe-rollback");
}

function safeTemplateText(value) {
  return String(value || "").slice(0, SKILL_CONTENT_MAX_CHARS);
}

function slugifySkillId(value, fallback = "custom-skill") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_ID_MAX_CHARS)
    .replace(/-+$/g, "");
  if (slug) return slug;
  return `${fallback}-${Date.now().toString(36)}`.slice(0, SKILL_ID_MAX_CHARS);
}

function humanizeSkillId(id) {
  return String(id || "Skill")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseSkillFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---")) {
    return {};
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    meta[field[1]] = field[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return meta;
}

function skillHeading(content) {
  const match = String(content || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function skillDescriptionFromContent(content) {
  const lines = String(content || "").split(/\r?\n/);
  let afterHeading = false;
  for (const line of lines) {
    if (!afterHeading) {
      afterHeading = /^#\s+/.test(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    return trimmed.slice(0, 220);
  }
  return "";
}

function describeSkill(id, content, preset, source) {
  const frontmatter = parseSkillFrontmatter(content);
  const name = frontmatter.name || preset?.name || skillHeading(content) || humanizeSkillId(id);
  const description = frontmatter.description || skillDescriptionFromContent(content) || "Custom agent workflow skill.";
  return {
    id,
    name,
    description,
    source,
    origin: preset ? "preset" : "custom"
  };
}

function createSkillContent({ id, name, description, content }) {
  const body = safeTemplateText(content);
  if (body.trim()) {
    return body;
  }
  const safeName = String(name || humanizeSkillId(id)).trim() || humanizeSkillId(id);
  const safeDescription = String(description || `Use when ${safeName} guidance is needed.`).trim();
  return [
    "---",
    `name: ${id}`,
    `description: ${safeDescription}`,
    "---",
    "",
    `# ${safeName}`,
    "",
    "## Overview",
    "",
    "Describe the reusable workflow, trigger conditions, and verification steps for this skill."
  ].join("\n");
}

function discoverSkillIds(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => fs.existsSync(path.join(root, id, "SKILL.md")))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function findSkillDirectories(sourcePath) {
  const resolved = path.resolve(sourcePath || "");
  if (!resolved || !fs.existsSync(resolved)) {
    return [];
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return [];
  }
  if (fs.existsSync(path.join(resolved, "SKILL.md"))) {
    return [resolved];
  }
  return fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(resolved, entry.name))
    .filter((candidate) => fs.existsSync(path.join(candidate, "SKILL.md")));
}

function copySkillDirectory(sourceDir, targetDir) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (source === target) {
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (candidate) => {
      const base = path.basename(candidate);
      return base !== ".git" && base !== "node_modules" && base !== ".DS_Store";
    }
  });
}

function copyBundledSkillDirectory(sourceDir, targetDir) {
  const source = resolveBundledResourcePath(path.isAbsolute(sourceDir) ? sourceDir : path.resolve(__dirname, sourceDir));
  const target = path.resolve(targetDir);
  if (!fs.existsSync(source) || !fs.existsSync(path.join(source, "SKILL.md"))) {
    return false;
  }
  if (fs.existsSync(path.join(target, "SKILL.md"))) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (candidate) => {
      const base = path.basename(candidate);
      return base !== ".git" && base !== "node_modules" && base !== ".DS_Store";
    }
  });
  return true;
}

function bundledSkillIds(preset) {
  const sourceDir = preset?.bundleDir || preset?.sourceDir;
  if (!sourceDir) {
    return [];
  }
  return discoverSkillIds(resolveBundledResourcePath(path.resolve(__dirname, sourceDir)));
}

function bundledChildSkillIds() {
  return new Set(Object.values(PRESET_SKILLS).flatMap((preset) => bundledSkillIds(preset)));
}

function runtimeSkillIdsForSelection(selectedIds) {
  const ids = [];
  for (const id of enabledList(selectedIds)) {
    const preset = PRESET_SKILLS[id];
    if (preset?.bundleDir) {
      ids.push(...bundledSkillIds(preset));
    } else if (preset?.sourceDir) {
      ids.push(preset.dir);
    } else {
      ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

function removeLegacyBundledSkillSplits(root, preset) {
  const sourceRoot = resolveBundledResourcePath(path.resolve(__dirname, preset.sourceDir || preset.bundleDir || ""));
  for (const skillId of bundledSkillIds(preset)) {
    const sourceSkill = path.join(sourceRoot, skillId, "SKILL.md");
    const targetDir = path.join(root, skillId);
    const targetSkill = path.join(targetDir, "SKILL.md");
    try {
      if (
        fs.existsSync(sourceSkill)
        && fs.existsSync(targetSkill)
        && fs.readFileSync(sourceSkill, "utf8") === fs.readFileSync(targetSkill, "utf8")
      ) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } catch {
      // Keep user-edited or unreadable directories rather than risking data loss.
    }
  }
}

function removeLegacyPresetDirs(root, preset) {
  for (const legacyDir of preset.legacyDirs || []) {
    const targetDir = path.join(root, legacyDir);
    const targetSkill = path.join(targetDir, "SKILL.md");
    try {
      if (!fs.existsSync(targetSkill)) continue;
      const content = fs.readFileSync(targetSkill, "utf8");
      const frontmatter = parseSkillFrontmatter(content);
      if (
        preset.legacyContent?.includes(content)
        || frontmatter.name === legacyDir
        || skillHeading(content) === preset.name.replace(" Pro Max", " Design")
      ) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } catch {
      // Keep user-edited or unreadable directories rather than risking data loss.
    }
  }
}

function shouldInstallBundledPreset(targetDir, preset) {
  const targetSkill = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(targetSkill)) {
    return true;
  }
  try {
    const content = fs.readFileSync(targetSkill, "utf8");
    return preset.legacyContent?.includes(content) || false;
  } catch {
    return false;
  }
}

function ensureInsideDirectory(parentDir, candidatePath) {
  const relativePath = path.relative(parentDir, candidatePath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function copyPresetSupportFiles(skillDir, preset) {
  const files = Array.isArray(preset.files) ? preset.files : [];
  for (const file of files) {
    const sourcePath = resolveBundledResourcePath(path.resolve(__dirname, file.source || ""));
    const targetPath = path.resolve(skillDir, file.target || "");
    if (!ensureInsideDirectory(skillDir, targetPath)) {
      throw new Error(`Invalid skill support file path: ${file.target || ""}`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    if (file.executable && process.platform !== "win32") {
      fs.chmodSync(targetPath, 0o755);
    }
  }
}

function createRemoteToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function trimString(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function trimSecret(value, maxLength = 8000) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeProvider(provider) {
  return provider === "nvidia-nim" ? "nvidia-nim" : "deepseek";
}

function trimOutput(value, maxLength = 12000) {
  return String(value || "").trim().slice(0, maxLength);
}

function createId(prefix = "") {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return prefix ? `${prefix}-${id}` : id;
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "scheduled-task";
}

function automationSlug(task) {
  const fromName = slugify(task.name || "");
  if (fromName && fromName !== "scheduled-task") {
    return fromName;
  }
  return slugify(task.id || "automation");
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function validateCronSchedule(schedule) {
  const value = String(schedule || "").trim();
  if (CRON_ALIASES.has(value)) {
    return true;
  }
  const fields = value.split(/\s+/);
  const fieldPattern = /^[A-Za-z0-9*,/?#L\-\[\]]+$/;
  return fields.length === 5 && fields.every((field) => fieldPattern.test(field));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function shellJoin(values) {
  return values.map((value) => shellQuote(value)).join(" ");
}

function cronEnvValue(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeCronPercent(command) {
  let escaped = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const previous = index > 0 ? command[index - 1] : "";
    escaped += char === "%" && previous !== "\\" ? "\\%" : char;
  }
  return escaped;
}

function normalizeAutomationFrequency(value) {
  return ["hourly", "daily", "weekly", "custom"].includes(value) ? value : "daily";
}

function normalizeAutomationStatus(input = {}, existing = {}) {
  const value = String(input.status || existing.status || "").trim().toUpperCase();
  if (value === "ACTIVE" || value === "PAUSED") {
    return value;
  }
  if ((input.installed || existing.installed) && input.enabled !== false && existing.enabled !== false) {
    return "ACTIVE";
  }
  if (Object.prototype.hasOwnProperty.call(input, "enabled") && input.enabled === true && !Object.prototype.hasOwnProperty.call(input, "installed")) {
    return "ACTIVE";
  }
  return "PAUSED";
}

function rruleTime(rrule) {
  const value = String(rrule || "");
  const hour = Number.parseInt(value.match(/(?:^|;)BYHOUR=(\d{1,2})(?:;|$)/)?.[1] || "", 10);
  const minute = Number.parseInt(value.match(/(?:^|;)BYMINUTE=(\d{1,2})(?:;|$)/)?.[1] || "", 10);
  return {
    hour: Number.isInteger(hour) ? hour : null,
    minute: Number.isInteger(minute) ? minute : null
  };
}

function buildAutomationRrule(task) {
  const hour = clampInteger(task.hour, 0, 23, 9);
  const minute = clampInteger(task.minute, 0, 59, 0);
  return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`;
}

function buildAutomationSchedule(task) {
  if (task.frequency === "hourly") {
    return `${task.minute} * * * *`;
  }
  if (task.frequency === "weekly") {
    return `${task.minute} ${task.hour} * * ${task.weekday}`;
  }
  if (task.frequency === "custom") {
    return task.customSchedule;
  }
  return `${task.minute} ${task.hour} * * *`;
}

function normalizeAutomationTask(input = {}, settings = {}, existing = {}) {
  const existingRruleTime = rruleTime(input.rrule || existing.rrule);
  const frequency = normalizeAutomationFrequency(input.frequency || existing.frequency || "daily");
  const minute = clampInteger(input.minute ?? existing.minute ?? existingRruleTime.minute, 0, 59, 0);
  const hour = clampInteger(input.hour ?? existing.hour ?? existingRruleTime.hour, 0, 23, 9);
  const weekday = clampInteger(input.weekday ?? existing.weekday, 0, 6, 1);
  const name = trimString(input.name || existing.name || "Scheduled Agent Task", 120);
  const prompt = String(input.prompt || existing.prompt || "").trim().slice(0, 20000);
  const customSchedule = trimString(input.customSchedule || existing.customSchedule || "0 9 * * *", 80);
  const timezone = trimString(input.timezone || existing.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", 80);
  const workspacePath = normalizeWorkspace(input.workspacePath || existing.workspacePath || settings.workspacePath);
  const status = normalizeAutomationStatus(input, existing);
  const selectedSkills = Array.isArray(input.enabledSkills)
    ? input.enabledSkills
    : Array.isArray(existing.enabledSkills)
      ? existing.enabledSkills
      : [];
  const enabledSkills = enabledList(selectedSkills).filter((id) => id !== "harness-probe-rollback");
  const task = {
    id: trimString(input.id || existing.id || createId("automation"), 100),
    kind: "cron",
    name,
    prompt,
    workspacePath,
    frequency,
    minute,
    hour,
    weekday,
    customSchedule,
    timezone,
    status,
    rrule: trimString(input.rrule || existing.rrule || "", 120),
    enabled: status === "ACTIVE",
    installed: Boolean(existing.installed),
    cronPath: existing.cronPath || "",
    logPath: existing.logPath || "",
    commandPreview: existing.commandPreview || "",
    runtimePath: existing.runtimePath || "",
    runnerPath: existing.runnerPath || "",
    runArgs: Array.isArray(existing.runArgs) ? existing.runArgs : [],
    provider: normalizeProvider(input.provider || existing.provider || settings.provider),
    model: trimString(input.model || existing.model || settings.model || DEFAULT_DEEPSEEK_MODEL, 120),
    baseUrl: trimString(input.baseUrl || existing.baseUrl || settings.baseUrl || defaultBaseUrlForProvider(settings.provider), 400),
    mcpConfigPath: trimString(input.mcpConfigPath || existing.mcpConfigPath || "", 1000),
    skillsDir: trimString(input.skillsDir || existing.skillsDir || "", 1000),
    enabledSkills,
    mcpEnabled: Boolean(input.mcpEnabled ?? existing.mcpEnabled),
    enabledMcpServers: Array.isArray(input.enabledMcpServers) ? input.enabledMcpServers : Array.isArray(existing.enabledMcpServers) ? existing.enabledMcpServers : [],
    allowShell: Boolean(input.allowShell ?? existing.allowShell),
    maxSubagents: normalizeMaxSubagents(input.maxSubagents || existing.maxSubagents || settings.maxSubagents),
    harnessEnabled: false,
    error: "",
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastGeneratedAt: existing.lastGeneratedAt || "",
    lastInstalledAt: existing.lastInstalledAt || ""
  };
  task.rrule = task.rrule || buildAutomationRrule(task);
  task.schedule = buildAutomationSchedule(task);
  return task;
}

function sanitizeAutomationStore(store) {
  const tasks = Array.isArray(store?.tasks) ? store.tasks : [];
  return {
    version: AUTOMATION_STORE_VERSION,
    tasks: tasks.map((task) => normalizeAutomationTask(task, {}, task))
  };
}

function gitResultError(result, fallback) {
  if (result.error) {
    return result.error.message || fallback;
  }
  return trimOutput(result.stderr || result.stdout) || fallback;
}

function runGit(args, cwd, timeout = GIT_COMMAND_TIMEOUT) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: desktopEnv(),
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4
  });
}

function parseGitRemotes(output) {
  const remotesByName = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const remote = remotesByName.get(name) || { name, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") remote.fetchUrl = url;
    if (kind === "push") remote.pushUrl = url;
    remotesByName.set(name, remote);
  }
  return Array.from(remotesByName.values());
}

function parseGitChanges(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3),
      staged: line[0] !== " " && line[0] !== "?",
      unstaged: line[1] !== " " && line[1] !== "?",
      untracked: line.startsWith("??")
    }));
}

function parseGitBranches(output, type, currentBranch = "") {
  return String(output || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [nameRaw = "", upstream = "", head = "", commit = "", subject = ""] = line.split("\0");
      const name = nameRaw.trim();
      return {
        name,
        type,
        current: type === "local" && (head.trim() === "*" || name === currentBranch),
        upstream: upstream.trim(),
        commit: commit.trim(),
        subject: subject.trim()
      };
    })
    .filter((branch) => branch.name && !/\/HEAD$/.test(branch.name));
}

function uniqueGitBranches(branches) {
  const seen = new Set();
  return branches.filter((branch) => {
    const key = `${branch.type}:${branch.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listGitBranches(repoRoot, currentBranch) {
  const format = "%(refname:short)%00%(upstream:short)%00%(HEAD)%00%(objectname:short)%00%(contents:subject)";
  const localResult = runGit(["for-each-ref", `--format=${format}`, "refs/heads"], repoRoot, 10000);
  const remoteResult = runGit(["for-each-ref", `--format=${format}`, "refs/remotes"], repoRoot, 10000);
  const branches = uniqueGitBranches([
    ...parseGitBranches(localResult.status === 0 ? localResult.stdout : "", "local", currentBranch),
    ...parseGitBranches(remoteResult.status === 0 ? remoteResult.stdout : "", "remote", currentBranch)
  ]);
  if (currentBranch && currentBranch !== "HEAD" && !branches.some((branch) => branch.type === "local" && branch.name === currentBranch)) {
    branches.unshift({
      name: currentBranch,
      type: "local",
      current: true,
      upstream: "",
      commit: "",
      subject: ""
    });
  }
  return branches;
}

function parseAheadBehind(output) {
  const [aheadRaw, behindRaw] = String(output || "").trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw, 10) || 0,
    behind: Number.parseInt(behindRaw, 10) || 0
  };
}

function isGitHubRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/i.test(value)
    || /^git@github\.com:[^/\s]+\/[^/\s]+\.git$/i.test(value)
    || /^ssh:\/\/git@github\.com\/[^/\s]+\/[^/\s]+\.git$/i.test(value);
}

function commandExists(command) {
  if (!command) return false;
  if (path.isAbsolute(command)) {
    return fs.existsSync(command);
  }
  const executable = process.platform === "win32" && !/\.(cmd|exe|bat)$/i.test(command)
    ? `${command}.cmd`
    : command;
  return Boolean(findOnPath(executable) || findOnPath(command));
}

function normalizeMcpArgs(args) {
  return Array.isArray(args) ? args.map((value) => String(value)) : [];
}

function missingEnvKeys(env) {
  return Object.entries(env || {})
    .filter(([, value]) => !String(value || "").trim())
    .map(([key]) => key);
}

function mcpConfigEnvKeys(keys) {
  return keys.filter((key) => /URL|URI|CONNECTION|HOST|BASE/i.test(key));
}

function mcpConfigWarnings(id, args, env) {
  const warnings = [];
  const joinedArgs = normalizeMcpArgs(args).join(" ");
  if (/example\.com|<remote-url>|<connection-string>|<workspace>/i.test(joinedArgs)) {
    warnings.push("Command arguments still contain a placeholder.");
  }
  if (id === "postgres" && /postgresql:\/\/localhost\/postgres/i.test(joinedArgs)) {
    warnings.push("Postgres is using the localhost fallback connection string.");
  }
  if (id === "mcp-remote" && /example\.com/i.test(joinedArgs)) {
    warnings.push("MCP Remote needs a real MCP_REMOTE_URL before it can connect.");
  }
  if (id === "pannel" && missingEnvKeys(env).length > 0) {
    warnings.push("Panel / 1Panel needs PANEL_HOST and PANEL_ACCESS_TOKEN in the environment.");
  }
  return warnings;
}

function validMcpServerUrl(url) {
  const value = String(url || "").trim();
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function mcpServerDiagnostic(entry) {
  const hasUrl = Boolean(String(entry.url || "").trim());
  const urlValid = validMcpServerUrl(entry.url);
  const commandFound = hasUrl ? true : commandExists(entry.command);
  const missingEnv = missingEnvKeys(entry.env);
  const missingConfigEnv = mcpConfigEnvKeys(missingEnv);
  const configWarnings = mcpConfigWarnings(entry.id, entry.args, entry.env);
  const warnings = [
    ...configWarnings,
    ...(hasUrl && !urlValid ? ["Server URL must start with http:// or https://."] : []),
    ...(!hasUrl && commandFound ? [] : hasUrl ? [] : ["Command is not available in PATH."]),
    ...(missingEnv.length > 0 ? [`Missing environment variables: ${missingEnv.join(", ")}`] : [])
  ];

  let status = "ready";
  if (hasUrl && !urlValid) {
    status = "invalid-url";
  } else if (!hasUrl && !commandFound) {
    status = "command-missing";
  } else if (missingConfigEnv.length > 0 || configWarnings.length > 0) {
    status = "needs-config";
  } else if (missingEnv.length > 0) {
    status = "needs-auth";
  }

  return {
    id: entry.id,
    command: entry.command,
    args: entry.args,
    url: entry.url,
    ok: status === "ready",
    injectable: status === "ready",
    status,
    commandFound,
    missingEnv,
    warnings
  };
}

function normalizeGitCommitMessage(message) {
  return String(message || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}

function projectIdFromWorkspace(workspacePath) {
  const normalized = String(workspacePath || "").trim().replace(/[\\/]+$/, "");
  return normalized || "no-workspace";
}

function projectNameFromWorkspace(workspacePath) {
  const projectId = projectIdFromWorkspace(workspacePath);
  if (projectId === "no-workspace") {
    return "No workspace";
  }
  return projectId.split(/[\\/]/).filter(Boolean).pop() || projectId;
}

function sanitizeConversationMessage(message) {
  return {
    id: trimString(message?.id, 80) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: message?.role === "user" ? "user" : "assistant",
    title: trimString(message?.title, 120),
    content: String(message?.content || "").slice(0, 20000)
  };
}

function sanitizeConversationStore(history) {
  const sourceProjects = Array.isArray(history?.projects) ? history.projects : [];
  const projects = [];
  const seenProjectIds = new Set();
  const seenSessionIds = new Set();

  for (const project of sourceProjects) {
    const workspacePath = String(project?.workspacePath || "");
    const fallbackProjectId = projectIdFromWorkspace(workspacePath);
    let projectId = trimString(project?.id, 240) || fallbackProjectId;
    if (seenProjectIds.has(projectId)) {
      projectId = `${projectId}-${projects.length + 1}`;
    }
    seenProjectIds.add(projectId);

    const sessions = [];
    const sourceSessions = Array.isArray(project?.sessions) ? project.sessions : [];
    for (const session of sourceSessions) {
      let sessionId = trimString(session?.id, 80);
      if (!sessionId || seenSessionIds.has(sessionId)) {
        sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      }
      seenSessionIds.add(sessionId);

      const sessionWorkspace = String(session?.workspacePath || workspacePath || "");
      const createdAt = trimString(session?.createdAt, 40) || new Date().toISOString();
      sessions.push({
        id: sessionId,
        projectId,
        projectName: trimString(session?.projectName || project?.name || projectNameFromWorkspace(sessionWorkspace), 120),
        workspacePath: sessionWorkspace,
        runtimeThreadId: trimString(session?.runtimeThreadId, 120),
        title: trimString(session?.title, 120),
        createdAt,
        updatedAt: trimString(session?.updatedAt, 40) || createdAt,
        messages: Array.isArray(session?.messages)
          ? session.messages.slice(0, 400).map(sanitizeConversationMessage)
          : []
      });
    }

    projects.push({
      id: projectId,
      name: trimString(project?.name || projectNameFromWorkspace(workspacePath), 120),
      workspacePath,
      sessions
    });
  }

  const activeSessionId = trimString(history?.activeSessionId, 80);
  return {
    activeSessionId: seenSessionIds.has(activeSessionId) ? activeSessionId : "",
    projects
  };
}

class DeepSeekDesktopHarness extends EventEmitter {
  constructor(electronApp) {
    super();
    this.app = electronApp;
    this.terminalProcess = null;
    this.activeSession = null;
    this.lastExit = null;
    this.runtimeState = new DeepSeekRuntimeState();
    this.runtimeState.on("runtime:event", (event) => this.emit("runtime:event", event));
    this.runtimeState.on("runtime:snapshot", (snapshot) => this.emit("runtime:snapshot", snapshot));
  }

  userDataPath(file) {
    return path.join(this.app.getPath("userData"), file);
  }

  packageRoot() {
    return this.app.getAppPath();
  }

  bundledDeepseekPath() {
    const packageRoot = this.packageRoot();
    const relativeBinary = path.join(
      "node_modules",
      "deepseek-tui",
      "bin",
      "downloads",
      binaryName("deepseek")
    );
    const candidate = path.join(packageRoot, relativeBinary);
    const unpackedCandidate = unpackAsar(candidate);
    if (fs.existsSync(unpackedCandidate)) {
      return unpackedCandidate;
    }

    const packagedResourceCandidate = path.join(packageRoot, "app.asar.unpacked", relativeBinary);
    if (fs.existsSync(packagedResourceCandidate)) {
      return packagedResourceCandidate;
    }

    return unpackedCandidate;
  }

  readSettings() {
    try {
      const raw = fs.readFileSync(this.userDataPath("settings.json"), "utf8");
      const parsed = JSON.parse(raw);
      const safeSettings = sanitizeSettings(parsed);
      if (!parsed.mobileBridgeToken || JSON.stringify(parsed) !== JSON.stringify(safeSettings)) {
        this.writeSettings(safeSettings);
      }
      return safeSettings;
    } catch {
      return this.writeSettings(defaultSettings());
    }
  }

  writeSettings(settings) {
    const safeSettings = sanitizeSettings(settings);
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(this.userDataPath("settings.json"), JSON.stringify(safeSettings, null, 2));
    return safeSettings;
  }

  readSecretStore() {
    try {
      const raw = fs.readFileSync(this.userDataPath("secrets.json"), "utf8");
      const parsed = JSON.parse(raw);
      return {
        version: SECRET_STORE_VERSION,
        apiKeys: {
          deepseek: trimSecret(parsed?.apiKeys?.deepseek),
          "nvidia-nim": trimSecret(parsed?.apiKeys?.["nvidia-nim"])
        },
        mcpEnv: Object.fromEntries(
          Object.entries(parsed?.mcpEnv || {})
            .filter(([key]) => /^[A-Z0-9_]+$/.test(key))
            .map(([key, value]) => [key, trimSecret(value)])
            .filter(([, value]) => Boolean(value))
        )
      };
    } catch {
      return {
        version: SECRET_STORE_VERSION,
        apiKeys: {
          deepseek: "",
          "nvidia-nim": ""
        },
        mcpEnv: {}
      };
    }
  }

  writeSecretStore(store) {
    const safeStore = {
      version: SECRET_STORE_VERSION,
      apiKeys: {
        deepseek: trimSecret(store?.apiKeys?.deepseek),
        "nvidia-nim": trimSecret(store?.apiKeys?.["nvidia-nim"])
      },
      mcpEnv: Object.fromEntries(
        Object.entries(store?.mcpEnv || {})
          .filter(([key]) => /^[A-Z0-9_]+$/.test(key))
          .map(([key, value]) => [key, trimSecret(value)])
          .filter(([, value]) => Boolean(value))
      )
    };
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(this.userDataPath("secrets.json"), JSON.stringify(safeStore, null, 2), { mode: 0o600 });
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(this.userDataPath("secrets.json"), 0o600);
      } catch {
        // Best effort; the app can still launch if chmod is unavailable.
      }
    }
    return safeStore;
  }

  readApiKey(provider = "deepseek") {
    const safeProvider = normalizeProvider(provider);
    return this.readSecretStore().apiKeys[safeProvider] || "";
  }

  saveApiKey(payload = {}) {
    const provider = normalizeProvider(payload.provider);
    const apiKey = trimSecret(payload.apiKey);
    const current = this.readSecretStore();
    if (!apiKey) {
      return { ok: true, provider, hasKey: Boolean(current.apiKeys[provider]) };
    }

    const next = this.writeSecretStore({
      ...current,
      apiKeys: {
        ...current.apiKeys,
        [provider]: apiKey
      }
    });
    return { ok: true, provider, hasKey: Boolean(next.apiKeys[provider]) };
  }

  readMcpEnvSecret(name) {
    const key = String(name || "").trim().toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(key)) return "";
    return process.env[key] || this.readSecretStore().mcpEnv[key] || "";
  }

  saveMcpEnvSecret(payload = {}) {
    const key = String(payload.name || payload.key || "").trim().toUpperCase();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      return { ok: false, error: "Environment variable name is invalid.", key };
    }

    const value = trimSecret(payload.value);
    const current = this.readSecretStore();
    const nextMcpEnv = { ...current.mcpEnv };
    if (value) {
      nextMcpEnv[key] = value;
    } else {
      delete nextMcpEnv[key];
    }
    const next = this.writeSecretStore({ ...current, mcpEnv: nextMcpEnv });
    return {
      ok: true,
      key,
      configured: Boolean(process.env[key] || next.mcpEnv[key]),
      source: process.env[key] ? "environment" : next.mcpEnv[key] ? "desktop" : "missing"
    };
  }

  readConversationHistory() {
    try {
      const raw = fs.readFileSync(this.userDataPath("history.json"), "utf8");
      return sanitizeConversationStore(JSON.parse(raw));
    } catch {
      return this.writeConversationHistory({ activeSessionId: "", projects: [] });
    }
  }

  writeConversationHistory(history) {
    const safeHistory = sanitizeConversationStore(history);
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(this.userDataPath("history.json"), JSON.stringify(safeHistory, null, 2));
    return safeHistory;
  }

  readAutomations() {
    try {
      const raw = fs.readFileSync(this.userDataPath("automations.json"), "utf8");
      return sanitizeAutomationStore(JSON.parse(raw));
    } catch {
      return this.writeAutomations({ version: AUTOMATION_STORE_VERSION, tasks: [] });
    }
  }

  writeAutomations(store) {
    const safeStore = sanitizeAutomationStore(store);
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(this.userDataPath("automations.json"), JSON.stringify(safeStore, null, 2));
    return safeStore;
  }

  automationCronPaths(task) {
    const workspacePath = normalizeWorkspace(task.workspacePath);
    const slug = automationSlug(task);
    return {
      cronPath: path.join(workspacePath, ".deepseek", "cron", `${slug}.cron`),
      logPath: path.join(workspacePath, ".deepseek", "logs", `${slug}.log`)
    };
  }

  automationRunnerPath() {
    return this.userDataPath("automation-runner.cjs");
  }

  desktopAutomationMcpServerPath() {
    return resolveBundledResourcePath(path.resolve(__dirname, "desktop-automation-mcp.cjs"));
  }

  desktopAutomationMcpEnabled(settings) {
    return settings.skillsEnabled !== false
      && runtimeSkillIdsForSelection(settings.enabledSkills).includes("scheduled-task-agent");
  }

  desktopAutomationMcpEntry(settings, workspacePath) {
    const env = {
      ELECTRON_RUN_AS_NODE: "1",
      DEEPSEEK_DESKTOP_USER_DATA: this.app.getPath("userData"),
      DEEPSEEK_DESKTOP_APP_ROOT: this.packageRoot(),
      DEEPSEEK_DESKTOP_WORKSPACE: workspacePath
    };
    return {
      id: DESKTOP_AUTOMATION_MCP_ID,
      command: process.execPath,
      args: [this.desktopAutomationMcpServerPath()],
      env,
      url: ""
    };
  }

  writeAutomationRunner() {
    const filePath = this.automationRunnerPath();
    const content = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_PATH = ${JSON.stringify(DEFAULT_PATH)};
const DEFAULT_MAX_SUBAGENTS = ${DEFAULT_MAX_SUBAGENTS};
const LEGACY_DESKTOP_MAX_SUBAGENTS = ${LEGACY_DESKTOP_MAX_SUBAGENTS};
const userDataPath = __dirname;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataPath, file), "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeProvider(provider) {
  return provider === "nvidia-nim" ? "nvidia-nim" : "deepseek";
}

function normalizeMaxSubagents(value) {
  const number = Number(value);
  return !Number.isFinite(number) || number === LEGACY_DESKTOP_MAX_SUBAGENTS
    ? DEFAULT_MAX_SUBAGENTS
    : number;
}

function apiModelForProvider(provider, model) {
  if (normalizeProvider(provider) === "nvidia-nim") {
    return String(model || "deepseek-v4-pro").trim() || "deepseek-v4-pro";
  }
  switch (String(model || "").trim()) {
    case "deepseek-v4-flash":
    case "deepseek-v4-flash-1m":
    case "deepseek-chat":
    case "deepseek-reasoner":
      return "deepseek-v4-flash";
    case "deepseek-v4-pro":
    case "deepseek-v4-pro-1m":
    default:
      return "deepseek-v4-pro";
  }
}

const taskId = process.argv[2];
const store = readJson("automations.json", { tasks: [] });
const task = (store.tasks || []).find((candidate) => candidate.id === taskId);

if (!task) {
  console.error("Automation task was not found:", taskId || "(empty)");
  process.exit(2);
}

if (task.status !== "ACTIVE") {
  console.log("Automation is paused:", task.name || task.id);
  process.exit(0);
}

const provider = normalizeProvider(task.provider);
const secrets = readJson("secrets.json", { apiKeys: {} });
const apiKey = String((secrets.apiKeys || {})[provider] || "").trim();
const env = {
  ...process.env,
  PATH: process.env.PATH ? \`\${DEFAULT_PATH}${path.delimiter}\${process.env.PATH}\` : DEFAULT_PATH,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  DEEPSEEK_MODEL: apiModelForProvider(provider, task.model),
  DEEPSEEK_BASE_URL: task.baseUrl || "https://api.deepseek.com"
};

if (apiKey) {
  env.DEEPSEEK_API_KEY = apiKey;
  if (provider === "nvidia-nim") {
    env.NVIDIA_NIM_API_KEY = apiKey;
    env.NVIDIA_API_KEY = apiKey;
  }
}
if (provider !== "deepseek") env.DEEPSEEK_PROVIDER = provider;
if (task.mcpConfigPath) env.DEEPSEEK_MCP_CONFIG = task.mcpConfigPath;
if (task.skillsDir) env.DEEPSEEK_SKILLS_DIR = task.skillsDir;
if (Array.isArray(task.enabledSkills)) env.DEEPSEEK_DESKTOP_ENABLED_SKILLS = task.enabledSkills.join(",");
if (task.mcpEnabled && Array.isArray(task.enabledMcpServers)) env.DEEPSEEK_DESKTOP_ENABLED_MCP = task.enabledMcpServers.join(",");
if (typeof task.allowShell === "boolean") env.DEEPSEEK_ALLOW_SHELL = task.allowShell ? "1" : "0";
if (task.maxSubagents) env.DEEPSEEK_MAX_SUBAGENTS = String(normalizeMaxSubagents(task.maxSubagents));

const binary = task.runtimePath || "deepseek";
const args = Array.isArray(task.runArgs) && task.runArgs.length > 0
  ? task.runArgs.map((value) => String(value))
  : ["exec", "--auto", task.prompt || ""];
const result = spawnSync(binary, args, {
  cwd: task.workspacePath || process.cwd(),
  env,
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message || "Automation runner failed.");
  process.exit(1);
}
process.exit(typeof result.status === "number" ? result.status : 1);
`;
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(filePath, content, { mode: 0o700 });
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(filePath, 0o700);
      } catch {
        // Best effort; the runner can still be invoked directly by node.
      }
    }
    return filePath;
  }

  hasCliAuth(provider) {
    if (normalizeProvider(provider) !== "deepseek") {
      return false;
    }
    try {
      const raw = fs.readFileSync(path.join(os.homedir(), ".deepseek", "config.toml"), "utf8");
      return /api_key\s*=/.test(raw) || /auth/i.test(raw);
    } catch {
      return false;
    }
  }

  hasAutomationCredential(settings) {
    const provider = normalizeProvider(settings.provider);
    return Boolean(this.readApiKey(provider) || this.hasCliAuth(provider));
  }

  automationCommand(task, settings) {
    const runtime = this.resolveRuntime(settings);
    const binary = runtime.selected || "deepseek";
    const workspacePath = normalizeWorkspace(settings.workspacePath || task.workspacePath);
    const runtimeMcpServerIds = this.runtimeMcpServerIds(settings, workspacePath);
    const args = ["exec", ...mcpFeatureArgs({
      ...settings,
      runtimeMcpServerIds,
      runtimeMcpReady: this.runtimeMcpReady(settings, workspacePath),
      desktopAutomationMcpReady: this.desktopAutomationMcpEnabled(settings)
    }), "--auto", task.prompt].filter(Boolean);
    return {
      runtime,
      args,
      command: `${shellQuote(binary)} ${shellJoin(args)}`
    };
  }

  writeAutomationCronFile(task, settings) {
    if (!task.name) {
      return { ok: false, error: "Automation name is required." };
    }
    if (!task.prompt) {
      return { ok: false, error: "Automation prompt is required." };
    }
    if (!validateCronSchedule(task.schedule)) {
      return { ok: false, error: "Cron schedule is invalid." };
    }

    const workspacePath = normalizeWorkspace(task.workspacePath);
    const { cronPath, logPath } = this.automationCronPaths({ ...task, workspacePath });
    const settingsForRun = normalizeSettings({ ...this.readSettings(), ...settings, workspacePath });
    const { runtime, command, args } = this.automationCommand(task, settingsForRun);
    const mcpConfigPath = this.writePresetMcpConfig(settingsForRun, workspacePath);
    const skillsDir = this.writePresetSkills(settingsForRun);
    const runnerPath = this.writeAutomationRunner();
    const nodePath = findOnPath("node");
    const apiModel = apiModelForProvider(settingsForRun.provider, settingsForRun.model);
    const runtimeMcpServerIds = this.runtimeMcpServerIds(settingsForRun, workspacePath);

    fs.mkdirSync(path.dirname(cronPath), { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const envLines = [
      `SHELL=${process.platform === "win32" ? "cmd.exe" : "/bin/sh"}`,
      `PATH=${cronEnvValue(DEFAULT_PATH)}`,
      `CRON_TZ=${cronEnvValue(task.timezone || "UTC")}`,
      `DEEPSEEK_MODEL=${cronEnvValue(apiModel)}`,
      `DEEPSEEK_BASE_URL=${cronEnvValue(settingsForRun.baseUrl || defaultBaseUrlForProvider(settingsForRun.provider))}`
    ];
    if (settingsForRun.provider && settingsForRun.provider !== "deepseek") {
      envLines.push(`DEEPSEEK_PROVIDER=${cronEnvValue(settingsForRun.provider)}`);
    }
    if (mcpConfigPath) {
      envLines.push(`DEEPSEEK_MCP_CONFIG=${cronEnvValue(mcpConfigPath)}`);
    }
    if (skillsDir) {
      envLines.push(`DEEPSEEK_SKILLS_DIR=${cronEnvValue(skillsDir)}`);
    }
    if (settingsForRun.skillsEnabled !== false && settingsForRun.enabledSkills) {
      envLines.push(`DEEPSEEK_DESKTOP_ENABLED_SKILLS=${cronEnvValue(runtimeSkillIdsForSelection(settingsForRun.enabledSkills).join(","))}`);
    }
    if (settingsForRun.mcpEnabled && runtimeMcpServerIds.length > 0) {
      envLines.push(`DEEPSEEK_DESKTOP_ENABLED_MCP=${cronEnvValue(runtimeMcpServerIds.join(","))}`);
    }
    if (this.desktopAutomationMcpEnabled(settingsForRun)) {
      envLines.push("DEEPSEEK_DESKTOP_AUTOMATION_MCP=1");
    }
    if (settingsForRun.allowShell) {
      envLines.push("DEEPSEEK_ALLOW_SHELL=1");
    }
    const maxSubagents = normalizeMaxSubagents(settingsForRun.maxSubagents);
    if (maxSubagents) {
      envLines.push(`DEEPSEEK_MAX_SUBAGENTS=${cronEnvValue(String(maxSubagents))}`);
    }
    envLines.push(`DEEPSEEK_DESKTOP_USER_DATA=${cronEnvValue(this.app.getPath("userData"))}`);

    const warnings = [];
    const activating = task.status === "ACTIVE";
    if (activating && !runtime.selectedExists) {
      warnings.push("Selected DeepSeek runtime does not exist.");
    }
    if (activating && !nodePath) {
      warnings.push("Node.js is required to run local automations from cron.");
    }
    if (activating && !this.hasAutomationCredential(settingsForRun)) {
      warnings.push("No saved DeepSeek credential was found. Save an API key in Settings or run `deepseek auth set` before activating.");
    }
    if (activating && process.platform === "win32") {
      warnings.push("Local scheduled automation activation is not available on Windows yet.");
    }

    const runnerCommand = `${shellQuote(nodePath || "node")} ${shellQuote(runnerPath)} ${shellQuote(task.id)}`;

    const cronLine = [
      task.schedule,
      "cd",
      shellQuote(workspacePath),
      "&&",
      escapeCronPercent(runnerCommand),
      ">>",
      shellQuote(logPath),
      "2>&1"
    ].join(" ");

    const content = [
      "# Generated by DeepSeek TUI Desktop Scheduled Tasks.",
      `# Task: ${task.name}`,
      `# Task ID: ${task.id}`,
      `# Created: ${new Date().toISOString()}`,
      "# Managed by DeepSeek TUI Desktop. Do not edit this file directly.",
      "# Secrets are not written here. The runner reads the desktop secret store at execution time.",
      "",
      ...envLines,
      "",
      cronLine,
      ""
    ].join(os.EOL);
    fs.writeFileSync(cronPath, content);

    return {
      ok: true,
      task: {
        ...task,
        workspacePath,
        cronPath,
        logPath,
        commandPreview: command,
        runtimePath: runtime.selected || "",
        runnerPath,
        runArgs: args,
        provider: settingsForRun.provider,
        model: apiModel,
        baseUrl: settingsForRun.baseUrl || defaultBaseUrlForProvider(settingsForRun.provider),
        mcpConfigPath,
        skillsDir,
        enabledSkills: runtimeSkillIdsForSelection(settingsForRun.enabledSkills),
        mcpEnabled: Boolean(settingsForRun.mcpEnabled),
        enabledMcpServers: runtimeMcpServerIds,
        allowShell: Boolean(settingsForRun.allowShell),
        maxSubagents,
        harnessEnabled: false,
        lastGeneratedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: warnings.join(" ")
      }
    };
  }

  saveAutomation(payload = {}) {
    const settings = sanitizeSettings({ ...this.readSettings(), ...(payload.settings || {}) });
    const store = this.readAutomations();
    const existing = store.tasks.find((task) => task.id === payload.task?.id) || {};
    const task = normalizeAutomationTask(payload.task || {}, settings, existing);
    const generated = this.writeAutomationCronFile(task, settings);
    if (!generated.ok) {
      return { ok: false, error: generated.error, tasks: store.tasks };
    }

    let storedTask = {
      ...generated.task,
      installed: Boolean(existing.installed),
      enabled: generated.task.status === "ACTIVE"
    };
    if (process.platform !== "win32") {
      const current = this.crontabRead();
      if (current.ok) {
        const withoutCurrent = this.removeManagedCronBlock(current.text, storedTask.id);
        if (storedTask.status === "ACTIVE" && !storedTask.error) {
          const block = this.managedCronBlock(storedTask);
          const nextCrontab = [withoutCurrent, block].filter(Boolean).join(os.EOL + os.EOL) + os.EOL;
          const result = this.crontabWrite(nextCrontab);
          storedTask = {
            ...storedTask,
            installed: result.status === 0,
            status: result.status === 0 ? "ACTIVE" : "PAUSED",
            enabled: result.status === 0,
            lastInstalledAt: result.status === 0 ? new Date().toISOString() : storedTask.lastInstalledAt,
            error: result.status === 0 ? storedTask.error : gitResultError(result, "Unable to update local automation schedule.")
          };
        } else {
          const currentTrimmed = String(current.text || "").trim();
          const result = withoutCurrent === currentTrimmed
            ? { status: 0 }
            : this.crontabWrite(withoutCurrent ? `${withoutCurrent}${os.EOL}` : "");
          storedTask = {
            ...storedTask,
            installed: result.status === 0 ? false : storedTask.installed,
            status: "PAUSED",
            enabled: false,
            error: result.status === 0 ? storedTask.error : gitResultError(result, "Unable to pause local automation schedule.")
          };
        }
      } else {
        storedTask = { ...storedTask, error: current.error || "Unable to read crontab." };
      }
    } else if (storedTask.status === "ACTIVE") {
      storedTask = {
        ...storedTask,
        status: "PAUSED",
        enabled: false,
        installed: false,
        error: storedTask.error || "Local scheduled automation activation is not available on Windows yet."
      };
    }

    const nextTasks = [
      storedTask,
      ...store.tasks.filter((candidate) => candidate.id !== storedTask.id)
    ].sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
    const nextStore = this.writeAutomations({ version: AUTOMATION_STORE_VERSION, tasks: nextTasks });
    return { ok: !storedTask.error, error: storedTask.error, task: storedTask, tasks: nextStore.tasks };
  }

  deleteAutomation(payload = {}) {
    const id = trimString(payload.id, 100);
    const store = this.readAutomations();
    const task = store.tasks.find((candidate) => candidate.id === id);
    if (task && process.platform !== "win32") {
      const current = this.crontabRead();
      if (current.ok) {
        const nextCrontab = this.removeManagedCronBlock(current.text, id);
        if (nextCrontab !== String(current.text || "").trim()) {
          this.crontabWrite(nextCrontab ? `${nextCrontab}${os.EOL}` : "");
        }
      }
    }
    const nextStore = this.writeAutomations({
      version: AUTOMATION_STORE_VERSION,
      tasks: store.tasks.filter((candidate) => candidate.id !== id)
    });
    if (task?.cronPath && task.cronPath.includes(`${path.sep}.deepseek${path.sep}cron${path.sep}`)) {
      try {
        fs.rmSync(task.cronPath, { force: true });
      } catch {
        // A missing generated file should not block deleting the local automation record.
      }
    }
    return { ok: true, tasks: nextStore.tasks };
  }

  managedCronBlock(task) {
    let content = "";
    try {
      content = fs.readFileSync(task.cronPath, "utf8").trim();
    } catch {
      return "";
    }
    return [
      `${AUTOMATION_CRON_BEGIN} ${task.id}`,
      content,
      `${AUTOMATION_CRON_END} ${task.id}`
    ].join(os.EOL);
  }

  removeManagedCronBlock(crontabText, taskId) {
    const escapedId = String(taskId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\n?${AUTOMATION_CRON_BEGIN} ${escapedId}[\\s\\S]*?${AUTOMATION_CRON_END} ${escapedId}\\n?`, "g");
    return String(crontabText || "").replace(pattern, "\n").trim();
  }

  crontabRead() {
    const result = spawnSync("crontab", ["-l"], {
      encoding: "utf8",
      env: desktopEnv(),
      windowsHide: true
    });
    if (result.status === 0) {
      return { ok: true, text: result.stdout || "" };
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (/no crontab/i.test(output)) {
      return { ok: true, text: "" };
    }
    return { ok: false, error: gitResultError(result, "Unable to read crontab.") };
  }

  crontabWrite(content) {
    return spawnSync("crontab", ["-"], {
      input: content,
      encoding: "utf8",
      env: desktopEnv(),
      windowsHide: true
    });
  }

  installAutomation(payload = {}) {
    const id = trimString(payload.id, 100);
    const store = this.readAutomations();
    const task = store.tasks.find((candidate) => candidate.id === id);
    if (!task) {
      return { ok: false, error: "Automation was not found.", tasks: store.tasks };
    }
    return this.saveAutomation({
      settings: payload.settings,
      task: { ...task, status: "ACTIVE", enabled: true }
    });
  }

  uninstallAutomation(payload = {}) {
    const id = trimString(payload.id, 100);
    const store = this.readAutomations();
    const task = store.tasks.find((candidate) => candidate.id === id);
    if (!task) {
      return { ok: false, error: "Automation was not found.", tasks: store.tasks };
    }
    return this.saveAutomation({
      settings: payload.settings,
      task: { ...task, status: "PAUSED", enabled: false }
    });
  }

  callAutomationBridgeTool(name, args = {}, settingsOverride = {}) {
    const toolName = String(name || "").trim();
    const settings = sanitizeSettings({ ...this.readSettings(), ...(settingsOverride || {}) });
    const payload = args && typeof args === "object" ? args : {};

    if (toolName === "automation_list") {
      const store = this.readAutomations();
      return {
        ok: true,
        tasks: store.tasks,
        count: store.tasks.length
      };
    }

    if (toolName === "automation_pause") {
      const id = trimString(payload.id, 100);
      if (!id) return { ok: false, error: "Task id is required." };
      const result = this.uninstallAutomation({ id, settings });
      return {
        ok: Boolean(result.ok),
        error: result.error || "",
        task: result.task || null,
        tasks: result.tasks || []
      };
    }

    if (toolName === "automation_delete") {
      const id = trimString(payload.id, 100);
      if (!id) return { ok: false, error: "Task id is required." };
      const result = this.deleteAutomation({ id });
      return {
        ok: Boolean(result.ok),
        error: result.error || "",
        tasks: result.tasks || []
      };
    }

    if (toolName === "automation_create") {
      const prompt = String(payload.prompt || "").trim();
      const hour = clampInteger(payload.hour, 0, 23, Number.NaN);
      const minute = clampInteger(payload.minute, 0, 59, Number.NaN);
      if (!prompt) return { ok: false, error: "Automation prompt is required." };
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        return { ok: false, error: "Automation hour and minute are required." };
      }

      const task = {
        name: trimString(payload.name || "Scheduled Agent Task", 120),
        prompt,
        workspacePath: normalizeWorkspace(payload.workspacePath || settings.workspacePath),
        hour,
        minute,
        timezone: trimString(payload.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", 80),
        status: String(payload.status || "ACTIVE").toUpperCase() === "PAUSED" ? "PAUSED" : "ACTIVE",
        enabled: String(payload.status || "ACTIVE").toUpperCase() !== "PAUSED"
      };
      const result = this.saveAutomation({ settings, task });
      const savedTask = result.task || null;
      return {
        ok: Boolean(result.ok),
        error: result.error || "",
        id: savedTask?.id || "",
        status: savedTask?.status || "",
        installed: Boolean(savedTask?.installed),
        cronPath: savedTask?.cronPath || "",
        logPath: savedTask?.logPath || "",
        task: savedTask,
        tasks: result.tasks || []
      };
    }

    return { ok: false, error: `Unknown automation tool: ${toolName}` };
  }

  rotateRemoteToken() {
    const settings = this.readSettings();
    return this.writeSettings({ ...settings, mobileBridgeToken: createRemoteToken() });
  }

  skillRoot(settings) {
    const safeSettings = sanitizeSettings({ ...this.readSettings(), ...(settings || {}) });
    return safeSettings.skillsDir ? path.resolve(safeSettings.skillsDir) : this.userDataPath("skills");
  }

  skillFilePath(settings, preset) {
    return path.join(this.skillRoot(settings), preset.dir, "SKILL.md");
  }

  customSkillFilePath(settings, skillId) {
    return path.join(this.skillRoot(settings), slugifySkillId(skillId), "SKILL.md");
  }

  readSkillTemplate(settings, id) {
    const preset = PRESET_SKILLS[id];
    const safeId = preset ? id : slugifySkillId(id);
    const filePath = preset ? this.skillFilePath(settings, preset) : this.customSkillFilePath(settings, safeId);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      return {
        ...describeSkill(safeId, content, preset, "file"),
        path: filePath,
        content
      };
    } catch {
      if (!preset) {
        return null;
      }
      return {
        ...describeSkill(safeId, preset.content, preset, "default"),
        path: filePath,
        content: preset.content
      };
    }
  }

  readCustomization(settings) {
    const safeSettings = sanitizeSettings({ ...this.readSettings(), ...(settings || {}) });
    const workspacePath = normalizeWorkspace(safeSettings.workspacePath);
    const skillTemplates = {};

    const root = this.skillRoot(safeSettings);
    if (safeSettings.skillsEnabled !== false) {
      this.writePresetSkills(safeSettings);
    }
    const bundledChildren = bundledChildSkillIds();
    const customSkillIds = discoverSkillIds(root).filter((id) => !bundledChildren.has(id));
    const skillIds = new Set([...Object.keys(PRESET_SKILLS), ...customSkillIds]);

    for (const id of skillIds) {
      const template = this.readSkillTemplate(safeSettings, id);
      if (template) {
        skillTemplates[id] = template;
      }
    }

    let mcpConfigSource = "generated";
    let mcpConfigPath = safeSettings.mcpConfigPath || "";
    let mcpConfigText = JSON.stringify(this.buildPresetMcpConfig(safeSettings, workspacePath), null, 2);
    let mcpConfigError = "";

    if (mcpConfigPath) {
      try {
        mcpConfigText = fs.readFileSync(path.resolve(mcpConfigPath), "utf8");
        mcpConfigSource = "custom";
      } catch (error) {
        mcpConfigSource = "missing";
        mcpConfigError = error.message || "Unable to read MCP config";
      }
    }

    return {
      skillRoot: root,
      skillTemplates,
      mcpConfigPath,
      mcpConfigSource,
      mcpConfigText,
      mcpConfigError
    };
  }

  createSkillTemplate(payload = {}) {
    const settings = sanitizeSettings({ ...this.readSettings(), ...(payload.settings || {}) });
    const skillId = slugifySkillId(payload.skillId || payload.name || "custom-skill");
    const filePath = this.customSkillFilePath(settings, skillId);
    const content = createSkillContent({
      id: skillId,
      name: payload.name,
      description: payload.description,
      content: payload.content
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return {
      ok: true,
      skill: this.readSkillTemplate(settings, skillId),
      path: filePath,
      skillRoot: this.skillRoot(settings)
    };
  }

  importSkillDirectory(payload = {}) {
    const settings = sanitizeSettings({ ...this.readSettings(), ...(payload.settings || {}) });
    const sourcePath = path.resolve(String(payload.sourcePath || ""));
    const sourceDirs = findSkillDirectories(sourcePath);
    if (!sourceDirs.length) {
      return { ok: false, error: "No SKILL.md files found in the selected directory" };
    }

    const root = this.skillRoot(settings);
    fs.mkdirSync(root, { recursive: true });
    const imported = [];
    for (const sourceDir of sourceDirs) {
      const fallback = path.basename(sourceDir);
      const sourceContent = fs.readFileSync(path.join(sourceDir, "SKILL.md"), "utf8");
      const meta = parseSkillFrontmatter(sourceContent);
      const skillId = slugifySkillId(meta.name || fallback);
      const targetDir = path.join(root, skillId);
      copySkillDirectory(sourceDir, targetDir);
      imported.push(this.readSkillTemplate(settings, skillId));
    }

    return {
      ok: true,
      skills: imported.filter(Boolean),
      path: root,
      skillRoot: root
    };
  }

  saveMcpConfig(payload = {}) {
    let parsed;
    try {
      parsed = JSON.parse(String(payload.content || ""));
    } catch (error) {
      return { ok: false, error: `Invalid MCP JSON: ${error.message}` };
    }

    const filePath = this.userDataPath("mcp.custom.json");
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));

    return {
      ok: true,
      path: filePath,
      content: JSON.stringify(parsed, null, 2)
    };
  }

  writePresetSkills(settings) {
    if (settings.skillsEnabled === false) {
      return "";
    }

    const selected = enabledList(settings.enabledSkills);
    if (selected.length === 0) {
      return settings.skillsDir || "";
    }

    const root = this.skillRoot(settings);
    fs.mkdirSync(root, { recursive: true });

    for (const id of selected) {
      const preset = PRESET_SKILLS[id];
      if (!preset) continue;
      if (preset.bundleDir) {
        const sourceRoot = resolveBundledResourcePath(path.resolve(__dirname, preset.bundleDir));
        for (const skillId of discoverSkillIds(sourceRoot)) {
          copyBundledSkillDirectory(path.join(sourceRoot, skillId), path.join(root, skillId));
        }
        continue;
      }
      if (preset.sourceDir) {
        removeLegacyBundledSkillSplits(root, preset);
        removeLegacyPresetDirs(root, preset);
        const targetDir = path.join(root, preset.dir);
        if (shouldInstallBundledPreset(targetDir, preset)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
          copyBundledSkillDirectory(resolveBundledResourcePath(path.resolve(__dirname, preset.sourceDir)), targetDir);
        }
        continue;
      }
      const skillDir = path.join(root, preset.dir);
      const filePath = path.join(skillDir, "SKILL.md");
      fs.mkdirSync(skillDir, { recursive: true });
      const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
      const shouldWrite = !fs.existsSync(filePath)
        || (Array.isArray(preset.legacyContent) && preset.legacyContent.includes(fs.readFileSync(filePath, "utf8")));
      const shouldRefreshScheduledTaskAgent = id === "scheduled-task-agent"
        && existingContent
        && (
          existingContent.includes("Do not try to call, invent, or center the answer around `automation_create`")
          || !existingContent.includes("call the built-in `automation_create` tool")
        );
      if (shouldWrite || shouldRefreshScheduledTaskAgent) {
        fs.writeFileSync(filePath, preset.content);
      }
      copyPresetSupportFiles(skillDir, preset);
    }

    return root;
  }

  mcpPresetEnv(preset) {
    const env = { ...preset.env() };
    for (const key of Object.keys(env)) {
      if (!String(env[key] || "").trim()) {
        env[key] = this.readMcpEnvSecret(key);
      }
    }
    return env;
  }

  mcpPresetArgs(id, preset, workspacePath, env) {
    if (id === "mcp-remote" && env.MCP_REMOTE_URL) {
      return ["-y", "mcp-remote", env.MCP_REMOTE_URL];
    }
    if (id === "postgres" && env.POSTGRES_CONNECTION_STRING) {
      return ["-y", "@modelcontextprotocol/server-postgres", env.POSTGRES_CONNECTION_STRING];
    }
    return typeof preset.args === "function" ? preset.args(workspacePath) : preset.args;
  }

  mcpPresetEntry(id, workspacePath) {
    const preset = MCP_PRESETS[id];
    if (!preset) return null;
    const env = this.mcpPresetEnv(preset);
    const args = this.mcpPresetArgs(id, preset, workspacePath, env);
    return {
      id,
      command: preset.command,
      args: normalizeMcpArgs(args),
      env,
      url: ""
    };
  }

  runtimeMcpServerIds(settings, workspacePath) {
    if (!settings.mcpEnabled || settings.mcpConfigPath) {
      return [];
    }
    return enabledList(settings.enabledMcpServers).filter((id) => {
      const entry = this.mcpPresetEntry(id, workspacePath);
      return entry && mcpServerDiagnostic(entry).injectable;
    });
  }

  runtimeMcpReady(settings, workspacePath) {
    if (this.desktopAutomationMcpEnabled(settings)) return true;
    if (!settings.mcpEnabled) return false;
    if (settings.mcpConfigPath) {
      try {
        return this.readMcpServerEntries(settings, workspacePath)
          .entries
          .some((entry) => mcpServerDiagnostic(entry).injectable);
      } catch {
        return false;
      }
    }
    return this.runtimeMcpServerIds(settings, workspacePath).length > 0;
  }

  buildPresetMcpConfig(settings, workspacePath, options = {}) {
    const selected = enabledList(settings.enabledMcpServers);
    const servers = {};

    for (const id of selected) {
      const entry = this.mcpPresetEntry(id, workspacePath);
      if (!entry) continue;
      if (options.runtimeOnly && !mcpServerDiagnostic(entry).injectable) {
        continue;
      }
      servers[id] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
        url: null,
        connect_timeout: null,
        execute_timeout: null,
        read_timeout: null,
        disabled: false,
        enabled: true,
        required: false,
        enabled_tools: [],
        disabled_tools: []
      };
    }

    return {
      timeouts: {
        connect_timeout: 10,
        execute_timeout: 60,
        read_timeout: 120
      },
      servers
    };
  }

  addDesktopAutomationMcpServer(config, settings, workspacePath) {
    if (!this.desktopAutomationMcpEnabled(settings)) {
      return config;
    }
    const entry = this.desktopAutomationMcpEntry(settings, workspacePath);
    config.servers[DESKTOP_AUTOMATION_MCP_ID] = {
      command: entry.command,
      args: entry.args,
      env: entry.env,
      url: null,
      connect_timeout: null,
      execute_timeout: null,
      read_timeout: null,
      disabled: false,
      enabled: true,
      required: false,
      enabled_tools: ["automation_create", "automation_list", "automation_pause", "automation_delete"],
      disabled_tools: []
    };
    return config;
  }

  writePresetMcpConfig(settings, workspacePath) {
    const includeAutomationBridge = this.desktopAutomationMcpEnabled(settings);
    if (!settings.mcpEnabled && !includeAutomationBridge) {
      return "";
    }

    if (settings.mcpConfigPath) {
      const source = settings.mcpEnabled
        ? this.readMcpServerEntries(settings, workspacePath)
        : { entries: [] };
      const entries = source.entries.filter((entry) => mcpServerDiagnostic(entry).injectable);
      if (entries.length === 0 && !includeAutomationBridge) {
        return "";
      }
      const filePath = this.userDataPath("mcp.runtime.json");
      const servers = Object.fromEntries(entries.map((entry) => [
        entry.id,
        {
          command: entry.command,
          args: entry.args,
          env: entry.env,
          url: entry.url || null,
          disabled: false,
          enabled: true,
          required: false,
          enabled_tools: [],
          disabled_tools: []
        }
      ]));
      const config = {
        timeouts: {
          connect_timeout: 10,
          execute_timeout: 60,
          read_timeout: 120
        },
        servers
      };
      this.addDesktopAutomationMcpServer(config, settings, workspacePath);
      fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
      return filePath;
    }

    const selected = settings.mcpEnabled ? enabledList(settings.enabledMcpServers) : [];
    if (selected.length === 0 && !includeAutomationBridge) {
      return "";
    }

    const configForRuntime = this.buildPresetMcpConfig({
      ...settings,
      enabledMcpServers: selected
    }, workspacePath, { runtimeOnly: true });
    this.addDesktopAutomationMcpServer(configForRuntime, settings, workspacePath);
    if (Object.keys(configForRuntime.servers).length === 0) {
      return "";
    }
    const filePath = this.userDataPath("mcp.presets.json");
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(configForRuntime, null, 2));
    return filePath;
  }

  writeDesktopManagedConfig(settings) {
    const safeSettings = sanitizeSettings(settings);
    const filePath = path.join(this.app.getPath("userData"), DESKTOP_MANAGED_CONFIG_FILE);
    const content = [
      "# Generated by DeepSeek TUI Desktop.",
      "# Controls DeepSeek thinking output and long-context retention for the desktop runtime.",
      `reasoning_effort = "${desktopProcessReasoningEffort(safeSettings)}"`,
      "",
      "[context]",
      `enabled = ${safeSettings.layeredContextEnabled ? "true" : "false"}`,
      `verbatim_window_turns = ${safeSettings.contextVerbatimWindowTurns}`,
      'seam_model = "deepseek-v4-flash"',
      ""
    ].join(os.EOL);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // chmod is best effort on filesystems that do not support POSIX modes.
    }
    return filePath;
  }

  readMcpServerEntries(settings, workspacePath) {
    if (settings.mcpConfigPath) {
      const configPath = path.resolve(settings.mcpConfigPath);
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const servers = parsed?.servers && typeof parsed.servers === "object" ? parsed.servers : {};
      const entries = Object.entries(servers)
        .filter(([, server]) => server?.disabled !== true && server?.enabled !== false)
        .map(([id, server]) => ({
          id,
          command: String(server?.command || ""),
          args: normalizeMcpArgs(server?.args),
          env: server?.env && typeof server.env === "object" ? server.env : {},
          url: String(server?.url || "")
        }));
      if (this.desktopAutomationMcpEnabled(settings)) {
        entries.unshift(this.desktopAutomationMcpEntry(settings, workspacePath));
      }
      return {
        configPath,
        entries
      };
    }

    const selected = enabledList(settings.enabledMcpServers);
    const entries = selected
      .map((id) => {
        return this.mcpPresetEntry(id, workspacePath);
      })
      .filter(Boolean);
    if (this.desktopAutomationMcpEnabled(settings)) {
      entries.unshift(this.desktopAutomationMcpEntry(settings, workspacePath));
    }
    return {
      configPath: "",
      entries
    };
  }

  testMcpServers(payload = {}) {
    const settings = sanitizeSettings({ ...this.readSettings(), ...(payload.settings || {}) });
    const workspacePath = normalizeWorkspace(settings.workspacePath);
    let source;
    try {
      source = this.readMcpServerEntries(settings, workspacePath);
    } catch (error) {
      return {
        ok: false,
        testedAt: new Date().toISOString(),
        configPath: settings.mcpConfigPath || "",
        servers: [],
        error: error.message || "Unable to read MCP config."
      };
    }

    const servers = source.entries.map((entry) => mcpServerDiagnostic(entry));

    return {
      ok: servers.every((server) => server.ok),
      testedAt: new Date().toISOString(),
      configPath: source.configPath,
      servers
    };
  }

  resolveRuntime(settings) {
    const custom = settings.customBinaryPath ? path.resolve(settings.customBinaryPath) : "";
    const bundled = this.bundledDeepseekPath();
    const system = findOnPath(process.platform === "win32" ? "deepseek.exe" : "deepseek");

    let selected = bundled;
    if (settings.binaryMode === "system" && system) {
      selected = system;
    }
    if (settings.binaryMode === "custom" && custom) {
      selected = custom;
    }

    return {
      selected,
      selectedExists: selected ? fs.existsSync(selected) : false,
      bundled,
      bundledExists: fs.existsSync(bundled),
      system,
      systemExists: Boolean(system),
      custom,
      customExists: custom ? fs.existsSync(custom) : false
    };
  }

  checkRuntime(partialSettings) {
    const settings = normalizeSettings({ ...this.readSettings(), ...(partialSettings || {}) });
    const runtime = this.resolveRuntime(settings);
    return {
      ...runtime,
      version: runtimeVersion(runtime.selected)
    };
  }

  gitStatus(workspacePathInput) {
    const workspacePath = normalizeWorkspace(workspacePathInput);
    const gitVersion = runGit(["--version"], workspacePath, 5000);
    if (gitVersion.error || gitVersion.status !== 0) {
      return {
        ok: false,
        error: gitResultError(gitVersion, "Git is not available in PATH."),
        workspacePath,
        repoRoot: "",
        isRepo: false,
        branch: "",
        upstream: "",
        ahead: 0,
        behind: 0,
        hasChanges: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        branches: [],
        remotes: [],
        originUrl: "",
        lastCommit: null,
        changes: []
      };
    }

    const rootResult = runGit(["rev-parse", "--show-toplevel"], workspacePath, 5000);
    if (rootResult.status !== 0) {
      return {
        ok: true,
        workspacePath,
        repoRoot: "",
        isRepo: false,
        branch: "",
        upstream: "",
        ahead: 0,
        behind: 0,
        hasChanges: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        branches: [],
        remotes: [],
        originUrl: "",
        lastCommit: null,
        changes: []
      };
    }

    const repoRoot = trimOutput(rootResult.stdout);
    const branchResult = runGit(["branch", "--show-current"], repoRoot, 5000);
    const branch = trimOutput(branchResult.stdout) || "HEAD";
    const upstreamResult = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoRoot, 5000);
    const upstream = upstreamResult.status === 0 ? trimOutput(upstreamResult.stdout) : "";
    const aheadBehind = upstream
      ? parseAheadBehind(runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], repoRoot, 10000).stdout)
      : { ahead: 0, behind: 0 };
    const statusResult = runGit(["status", "--porcelain=v1", "-uall"], repoRoot, 10000);
    const changes = parseGitChanges(statusResult.stdout);
    const branches = listGitBranches(repoRoot, branch);
    const remotes = parseGitRemotes(runGit(["remote", "-v"], repoRoot, 5000).stdout);
    const origin = remotes.find((remote) => remote.name === "origin");
    const lastCommitResult = runGit(["log", "-1", "--pretty=format:%h%x1f%s%x1f%an%x1f%cr"], repoRoot, 5000);
    const lastCommitParts = lastCommitResult.status === 0 ? String(lastCommitResult.stdout || "").split("\x1f") : [];

    return {
      ok: true,
      workspacePath,
      repoRoot,
      isRepo: true,
      branch,
      upstream,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      hasChanges: changes.length > 0,
      staged: changes.filter((change) => change.staged).length,
      unstaged: changes.filter((change) => change.unstaged).length,
      untracked: changes.filter((change) => change.untracked).length,
      branches,
      remotes,
      originUrl: origin?.pushUrl || origin?.fetchUrl || "",
      lastCommit: lastCommitParts.length >= 4
        ? {
          hash: lastCommitParts[0] || "",
          subject: lastCommitParts[1] || "",
          author: lastCommitParts[2] || "",
          date: lastCommitParts[3] || ""
        }
        : null,
      changes
    };
  }

  gitInit(workspacePathInput) {
    const workspacePath = normalizeWorkspace(workspacePathInput);
    let result = runGit(["init", "-b", "main"], workspacePath);
    if (result.status !== 0) {
      result = runGit(["init"], workspacePath);
      if (result.status === 0) {
        runGit(["branch", "-M", "main"], workspacePath, 5000);
      }
    }

    if (result.status !== 0) {
      return {
        ok: false,
        error: gitResultError(result, "Unable to initialize Git repository."),
        output: trimOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
        status: this.gitStatus(workspacePath)
      };
    }

    return {
      ok: true,
      output: trimOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
      status: this.gitStatus(workspacePath)
    };
  }

  gitSetRemote(payload = {}) {
    const workspacePath = normalizeWorkspace(payload.workspacePath);
    const remoteUrl = String(payload.remoteUrl || "").trim();
    if (!isGitHubRemoteUrl(remoteUrl)) {
      return {
        ok: false,
        error: "Use a GitHub HTTPS or SSH remote URL.",
        status: this.gitStatus(workspacePath)
      };
    }

    const status = this.gitStatus(workspacePath);
    if (!status.isRepo) {
      return { ok: false, error: "Initialize Git before setting the GitHub remote.", status };
    }

    const hasOrigin = runGit(["remote", "get-url", "origin"], status.repoRoot, 5000).status === 0;
    const result = runGit(hasOrigin ? ["remote", "set-url", "origin", remoteUrl] : ["remote", "add", "origin", remoteUrl], status.repoRoot);
    if (result.status !== 0) {
      return {
        ok: false,
        error: gitResultError(result, "Unable to save GitHub remote."),
        output: trimOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
        status: this.gitStatus(workspacePath)
      };
    }

    return {
      ok: true,
      output: trimOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
      status: this.gitStatus(workspacePath)
    };
  }

  gitSwitchBranch(payload = {}) {
    const workspacePath = normalizeWorkspace(payload.workspacePath);
    const branchName = String(payload.branchName || "").trim();
    const status = this.gitStatus(workspacePath);
    if (!status.isRepo) {
      return { ok: false, error: "Workspace is not a Git repository.", status };
    }
    if (!branchName) {
      return { ok: false, error: "Choose a branch before switching.", status };
    }
    if (status.hasChanges) {
      return { ok: false, error: "Commit or stash local changes before switching branches.", status };
    }

    const target = status.branches.find((branch) => branch.name === branchName);
    if (!target) {
      return { ok: false, error: `Branch not found: ${branchName}`, status };
    }
    if (target.current) {
      return { ok: true, output: `Already on ${target.name}.`, status };
    }

    const localBranches = new Set(status.branches.filter((branch) => branch.type === "local").map((branch) => branch.name));
    const runSwitch = (args) => {
      const result = runGit(["switch", ...args], status.repoRoot, 120000);
      if (result.status === 0) return result;
      return runGit(["checkout", ...args], status.repoRoot, 120000);
    };

    let result;
    if (target.type === "local") {
      result = runSwitch([target.name]);
    } else {
      const localName = target.name.replace(/^[^/]+\//, "");
      if (!localName || localName === "HEAD") {
        return { ok: false, error: `Unsupported remote branch: ${target.name}`, status };
      }
      result = localBranches.has(localName)
        ? runSwitch([localName])
        : runSwitch(["--track", target.name]);
    }

    return {
      ok: result.status === 0,
      error: result.status === 0 ? "" : gitResultError(result, "Unable to switch branches."),
      output: trimOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
      status: this.gitStatus(workspacePath)
    };
  }

  gitRunWorkspaceAction(payload = {}, action) {
    const workspacePath = normalizeWorkspace(payload.workspacePath);
    const status = this.gitStatus(workspacePath);
    if (!status.isRepo) {
      return { ok: false, error: "Workspace is not a Git repository.", status };
    }
    if (action === "fetch" && !status.originUrl) {
      return { ok: false, error: "Set a GitHub origin remote before fetching.", status };
    }
    if (action === "pull" && !status.upstream) {
      return { ok: false, error: "Set an upstream branch before pulling.", status };
    }
    if (action === "push" && !status.originUrl) {
      return { ok: false, error: "Set a GitHub origin remote before pushing.", status };
    }

    let args = [];
    if (action === "fetch") {
      args = ["fetch", "--prune", "origin"];
    } else if (action === "pull") {
      args = ["pull", "--ff-only"];
    } else if (action === "push") {
      args = status.upstream ? ["push"] : ["push", "-u", "origin", status.branch || "main"];
    } else {
      return { ok: false, error: "Unsupported Git action.", status };
    }

    const result = runGit(args, status.repoRoot, 120000);
    return {
      ok: result.status === 0,
      error: result.status === 0 ? "" : gitResultError(result, `Git ${action} failed.`),
      output: trimOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
      status: this.gitStatus(workspacePath)
    };
  }

  gitCommit(payload = {}) {
    const workspacePath = normalizeWorkspace(payload.workspacePath);
    const message = normalizeGitCommitMessage(payload.message);
    const status = this.gitStatus(workspacePath);
    if (!status.isRepo) {
      return { ok: false, error: "Workspace is not a Git repository.", status };
    }
    if (!status.hasChanges) {
      return { ok: false, error: "There are no changes to commit.", status };
    }
    if (!message) {
      return { ok: false, error: "Commit message is required.", status };
    }

    const addResult = runGit(["add", "-A"], status.repoRoot, 120000);
    if (addResult.status !== 0) {
      return {
        ok: false,
        error: gitResultError(addResult, "Unable to stage changes."),
        output: trimOutput([addResult.stdout, addResult.stderr].filter(Boolean).join("\n")),
        status: this.gitStatus(workspacePath)
      };
    }

    const commitResult = runGit(["commit", "-m", message], status.repoRoot, 120000);
    return {
      ok: commitResult.status === 0,
      error: commitResult.status === 0 ? "" : gitResultError(commitResult, "Unable to create commit."),
      output: trimOutput([commitResult.stdout, commitResult.stderr].filter(Boolean).join("\n")),
      status: this.gitStatus(workspacePath)
    };
  }

  gitDiffSummary(payload = {}) {
    const workspacePath = normalizeWorkspace(payload.workspacePath);
    const status = this.gitStatus(workspacePath);
    if (!status.isRepo) {
      return { ok: false, error: "Workspace is not a Git repository.", status };
    }

    const unstaged = runGit(["diff", "--stat"], status.repoRoot, 10000);
    const staged = runGit(["diff", "--cached", "--stat"], status.repoRoot, 10000);
    const names = runGit(["status", "--short"], status.repoRoot, 10000);
    const sections = [];

    if (trimOutput(names.stdout)) {
      sections.push(["Changed files:", trimOutput(names.stdout)].join("\n"));
    }
    if (trimOutput(staged.stdout)) {
      sections.push(["Staged diff stat:", trimOutput(staged.stdout)].join("\n"));
    }
    if (trimOutput(unstaged.stdout)) {
      sections.push(["Unstaged diff stat:", trimOutput(unstaged.stdout)].join("\n"));
    }

    const errors = [names, staged, unstaged]
      .filter((result) => result.status !== 0)
      .map((result) => gitResultError(result, "Git diff failed."));

    if (errors.length > 0) {
      return {
        ok: false,
        error: errors[0],
        output: trimOutput(sections.join("\n\n")),
        status: this.gitStatus(workspacePath)
      };
    }

    return {
      ok: true,
      output: sections.length > 0 ? trimOutput(sections.join("\n\n")) : "No file changes to preview.",
      status: this.gitStatus(workspacePath)
    };
  }

  buildLaunchPlan(options) {
    const rawSettings = { ...this.readSettings(), ...options };
    const settings = normalizeSettings(rawSettings);
    settings.enabledSkills = enabledList(settings.enabledSkills).filter((id) => id !== "harness-probe-rollback");
    settings.harnessEnabled = false;
    const workspacePath = normalizeWorkspace(settings.workspacePath);
    const runtimeMcpServerIds = this.runtimeMcpServerIds(settings, workspacePath);
    const desktopAutomationMcpReady = this.desktopAutomationMcpEnabled(settings);
    const launchSettings = {
      ...settings,
      runtimeMcpServerIds,
      runtimeMcpReady: this.runtimeMcpReady(settings, workspacePath),
      desktopAutomationMcpReady
    };
    const runtime = this.resolveRuntime(settings);
    const args = this.buildArgs({ ...launchSettings, workspacePath });
    const env = this.buildEnv(launchSettings, workspacePath);
    const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      sessionId,
      command: runtime.selected,
      args,
      cwd: workspacePath,
      env,
      runtime,
      cols: Number(settings.cols) || 120,
      rows: Number(settings.rows) || 34,
      launchAction: settings.launchAction
    };
  }

  buildArgs(options) {
    const mcpArgs = mcpFeatureArgs(options);
    switch (options.launchAction) {
      case "continue":
        return ["run", ...mcpArgs, "--workspace", options.workspacePath, "--continue"];
      case "doctor":
        return ["doctor"];
      case "setup":
        return ["setup"];
      case "mcp-init":
        return ["setup", "--mcp"];
      case "sessions":
        return ["sessions", "--limit", "50"];
      case "exec":
        return ["exec", ...mcpArgs, "--auto", String(options.agentPrompt || "").trim()].filter(Boolean);
      case "plan":
        return ["exec", ...mcpArgs, "--auto", [
          "You are in Plan mode. Produce a concrete implementation plan only.",
          "Do not edit files, do not run destructive commands, and do not make external changes.",
          "Focus on steps, risks, required tools, and verification.",
          "",
          options.agentPrompt || ""
        ].join("\n").trim()].filter(Boolean);
      case "yolo":
        return ["run", ...mcpArgs, "--workspace", options.workspacePath, "--yolo", "-p", String(options.agentPrompt || "").trim()].filter(Boolean);
      case "tui":
      default:
        return ["run", ...mcpArgs, "--workspace", options.workspacePath];
    }
  }

  buildEnv(options, workspacePath) {
    const env = {
      ...desktopEnv(),
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    };

    const effectiveApiKey = trimSecret(options.apiKey) || this.readApiKey(options.provider);
    if (effectiveApiKey) {
      env.DEEPSEEK_API_KEY = effectiveApiKey;
      if (options.provider === "nvidia-nim") {
        env.NVIDIA_NIM_API_KEY = effectiveApiKey;
        env.NVIDIA_API_KEY = effectiveApiKey;
      }
    }
    env.DEEPSEEK_MODEL = apiModelForProvider(options.provider, options.model);
    if (options.baseUrl) {
      env.DEEPSEEK_BASE_URL = options.baseUrl;
      if (options.provider === "nvidia-nim") {
        env.NVIDIA_NIM_BASE_URL = options.baseUrl;
      }
    }
    if (options.provider && options.provider !== "deepseek") {
      env.DEEPSEEK_PROVIDER = options.provider;
    }
    const mcpConfigPath = this.writePresetMcpConfig(options, workspacePath);
    const skillsDir = this.writePresetSkills(options);
    if (mcpConfigPath) {
      env.DEEPSEEK_MCP_CONFIG = mcpConfigPath;
    }
    if (skillsDir) {
      env.DEEPSEEK_SKILLS_DIR = skillsDir;
    }
    if (options.skillsEnabled !== false && options.enabledSkills) {
      env.DEEPSEEK_DESKTOP_ENABLED_SKILLS = runtimeSkillIdsForSelection(options.enabledSkills).join(",");
    }
    const runtimeMcpServerIds = Array.isArray(options.runtimeMcpServerIds)
      ? enabledList(options.runtimeMcpServerIds)
      : this.runtimeMcpServerIds(options, workspacePath);
    if (options.mcpEnabled && runtimeMcpServerIds.length > 0) {
      env.DEEPSEEK_DESKTOP_ENABLED_MCP = runtimeMcpServerIds.join(",");
    }
    if (options.desktopAutomationMcpReady) {
      env.DEEPSEEK_DESKTOP_AUTOMATION_MCP = "1";
    }
    if (typeof options.allowShell === "boolean") {
      env.DEEPSEEK_ALLOW_SHELL = options.allowShell ? "1" : "0";
    }
    const maxSubagents = normalizeMaxSubagents(options.maxSubagents);
    if (maxSubagents) {
      env.DEEPSEEK_MAX_SUBAGENTS = String(maxSubagents);
    }
    env.DEEPSEEK_MANAGED_CONFIG_PATH = this.writeDesktopManagedConfig(options);

    return env;
  }

  start(options) {
    if (this.terminalProcess) {
      this.stop();
    }

    const plan = this.buildLaunchPlan(options);
    if (!plan.runtime.selectedExists) {
      this.runtimeState.startRun({
        ...plan,
        mode: plan.launchAction,
        workspacePath: plan.cwd
      });
      this.runtimeState.finishRun({ exitCode: 127 });
      const runtimeHint = this.app.isPackaged
        ? "The bundled DeepSeek runtime is missing from this app package. Reinstall the app, rebuild the package, or choose a custom deepseek executable.\r\n\r\n"
        : "Run `npm install` in this desktop project to download the bundled binary, or choose a custom deepseek executable.\r\n\r\n";
      this.emit("terminal:data", [
        "\r\nDeepSeek runtime not found.\r\n",
        `Selected: ${plan.runtime.selected || "(empty)"}\r\n`,
        runtimeHint
      ].join(""));
      return { ok: false, error: "Runtime not found", runtime: plan.runtime };
    }

    const pty = require("node-pty");
    this.terminalProcess = pty.spawn(plan.command, plan.args, {
      name: "xterm-256color",
      cols: plan.cols,
      rows: plan.rows,
      cwd: plan.cwd,
      env: plan.env
    });
    this.activeSession = {
      id: plan.sessionId,
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
      pid: this.terminalProcess.pid,
      startedAt: new Date().toISOString()
    };
    this.lastExit = null;
    this.runtimeState.startRun({
      ...plan,
      mode: plan.launchAction,
      workspacePath: plan.cwd,
      pid: this.terminalProcess.pid
    });

    this.terminalProcess.onData((data) => this.handleTerminalData(data));
    this.terminalProcess.onExit((exit) => {
      const session = this.activeSession;
      this.terminalProcess = null;
      this.activeSession = null;
      this.lastExit = { ...exit, session, exitedAt: new Date().toISOString() };
      this.runtimeState.finishRun(this.lastExit);
      this.emit("terminal:exit", this.lastExit);
    });

    return { ok: true, runtime: plan.runtime, pid: this.terminalProcess.pid, session: this.activeSession };
  }

  stop() {
    if (this.terminalProcess) {
      this.terminalProcess.kill();
      this.terminalProcess = null;
      this.activeSession = null;
      this.runtimeState.stopRun();
      return { ok: true };
    }
    return { ok: false };
  }

  handleTerminalData(data) {
    this.runtimeState.ingestTerminalData(data);
    this.emit("terminal:data", data);
  }

  input(data) {
    if (this.terminalProcess) {
      this.terminalProcess.write(data);
    }
  }

  resize(size) {
    if (this.terminalProcess && size && size.cols && size.rows) {
      this.terminalProcess.resize(size.cols, size.rows);
    }
  }

  getStatus() {
    return {
      running: Boolean(this.terminalProcess),
      activeSession: this.activeSession,
      lastExit: this.lastExit
    };
  }

  getRuntimeSnapshot() {
    return this.runtimeState.snapshot();
  }

  shutdown() {
    this.stop();
  }
}

module.exports = {
  DeepSeekDesktopHarness,
  copyBundledSkillDirectory,
  defaultSettings,
  desktopProcessReasoningEffort,
  normalizeDeepSeekThinkingMode
};
