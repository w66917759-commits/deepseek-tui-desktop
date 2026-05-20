export type TaskBoardParseResult =
  | { ok: true; plan: TaskBoardPlan }
  | { ok: false; error: string };

export interface TaskBoardMetadata {
  id?: string;
  sourcePrompt: string;
  model: string;
  activeSkillIds: string[];
  createdAt?: string;
}

export interface TaskBoardRouteOptions {
  prompt: string;
  permissionMode?: string;
  skillRoutingMode?: SkillRoutingMode;
  activeSkillIds: string[];
}

const VALID_AGENT_ROLES = new Set<TaskAgentRole>([
  "planner",
  "explorer",
  "worker",
  "reviewer",
  "tester",
  "build-fixer"
]);

const VALID_ITEM_STATUSES = new Set<TaskBoardItem["status"]>([
  "draft",
  "queued",
  "running",
  "completed",
  "failed",
  "blocked"
]);

const DECOMPOSITION_TRIGGER_PATTERN = /拆解|子\s*agent|子代理|多代理|分工|并行|多个\s*agent|多步骤|复杂实现|复杂任务|长任务|重构|架构|decompose|sub-?agent|delegate|parallel agents?|multi-?agent|task board|break\s+(it|this)\s+down/i;

function createTaskBoardId() {
  return `taskboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeId(value: unknown, fallback: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function stringField(value: unknown) {
  return String(value || "").trim();
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function extractJsonPayload(raw: string) {
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text;
}

function normalizeAgentRole(value: unknown): TaskAgentRole | "" {
  const role = String(value || "").trim().toLowerCase();
  if (VALID_AGENT_ROLES.has(role as TaskAgentRole)) return role as TaskAgentRole;
  if (role === "build_fixer" || role === "build fixer" || role === "buildfixer") return "build-fixer";
  return "";
}

function normalizeItemStatus(value: unknown): TaskBoardItem["status"] {
  const status = String(value || "").trim().toLowerCase();
  return VALID_ITEM_STATUSES.has(status as TaskBoardItem["status"])
    ? status as TaskBoardItem["status"]
    : "draft";
}

export function shouldCreateTaskBoard(options: TaskBoardRouteOptions) {
  const prompt = options.prompt.trim();
  if (!prompt) return false;
  if (options.skillRoutingMode === "manual") return false;
  if (!options.activeSkillIds.includes("superpowers")) return false;
  return prompt.length > 700 || DECOMPOSITION_TRIGGER_PATTERN.test(prompt);
}

export function buildTaskDecompositionPrompt(options: {
  sourcePrompt: string;
  model: string;
  activeSkillIds: string[];
  maxSubagents: number;
  language: AppLanguage;
  capabilityContext?: string;
}) {
  const maxSubagents = Math.max(1, Math.min(20, Number(options.maxSubagents) || 10));
  const languageInstruction = options.language === "zh"
    ? "任务标题和目标请使用中文。"
    : "Use English task titles and goals.";
  return [
    "You are the read-only task decomposition planner for DeepSeek TUI Desktop.",
    "Do not call tools. Do not edit files. Do not execute shell commands.",
    "Return only one fenced JSON block. No prose before or after it.",
    languageInstruction,
    "",
    "JSON shape:",
    "```json",
    "{",
    "  \"items\": [",
    "    {",
    "      \"id\": \"short-stable-id\",",
    "      \"title\": \"Task title\",",
    "      \"goal\": \"Concrete goal\",",
    "      \"agentRole\": \"planner|explorer|worker|reviewer|tester|build-fixer\",",
    "      \"dependencies\": [\"other-task-id\"],",
    "      \"targetAreas\": [\"src/App.tsx\"],",
    "      \"acceptance\": [\"Specific acceptance check\"],",
    "      \"status\": \"draft\"",
    "    }",
    "  ],",
    "  \"warnings\": [\"Risk or constraint\"]",
    "}",
    "```",
    "",
    `Use at most ${maxSubagents} task items. Prefer 3-6 items unless the task is very small.`,
    "Every item must have title, goal, agentRole, targetAreas, and acceptance.",
    "Dependencies must refer to ids from the same items list.",
    "Use reviewer/tester/build-fixer roles only when they represent real work.",
    "",
    `Active skills: ${options.activeSkillIds.join(", ") || "none"}`,
    `Model: ${options.model}`,
    options.capabilityContext ? "" : "",
    options.capabilityContext ? options.capabilityContext : "",
    "",
    "Original user request:",
    options.sourcePrompt
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

export function parseTaskBoardPlan(raw: string, metadata: TaskBoardMetadata): TaskBoardParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(raw));
  } catch {
    return { ok: false, error: "Task decomposition did not return valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Task decomposition JSON must be an object." };
  }

  const record = parsed as { items?: unknown; warnings?: unknown };
  if (!Array.isArray(record.items) || record.items.length === 0) {
    return { ok: false, error: "Task decomposition JSON must include a non-empty items array." };
  }

  const items: TaskBoardItem[] = [];
  const seen = new Set<string>();
  for (const [index, rawItem] of record.items.entries()) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return { ok: false, error: `Task item ${index + 1} must be an object.` };
    }
    const item = rawItem as Record<string, unknown>;
    const title = stringField(item.title);
    const goal = stringField(item.goal);
    const agentRole = normalizeAgentRole(item.agentRole);
    const targetAreas = stringList(item.targetAreas);
    const acceptance = stringList(item.acceptance);
    if (!title || !goal || !agentRole || targetAreas.length === 0 || acceptance.length === 0) {
      return { ok: false, error: `Task item ${index + 1} is missing required fields.` };
    }
    const id = normalizeId(item.id, `task-${index + 1}`);
    if (seen.has(id)) {
      return { ok: false, error: `Task item id is duplicated: ${id}.` };
    }
    seen.add(id);
    items.push({
      id,
      title,
      goal,
      agentRole,
      dependencies: stringList(item.dependencies),
      targetAreas,
      acceptance,
      status: normalizeItemStatus(item.status),
      runId: stringField(item.runId) || undefined,
      runtimeThreadId: stringField(item.runtimeThreadId) || undefined,
      runtimeTurnId: stringField(item.runtimeTurnId) || undefined,
      blockedReason: stringField(item.blockedReason) || undefined,
      outputSummary: stringField(item.outputSummary) || undefined,
      lastActivityAt: stringField(item.lastActivityAt) || undefined,
      completedAt: stringField(item.completedAt) || undefined
    });
  }

  for (const item of items) {
    const unknownDependency = item.dependencies.find((dependency) => !seen.has(dependency));
    if (unknownDependency) {
      return { ok: false, error: `Task item ${item.id} depends on unknown task ${unknownDependency}.` };
    }
  }

  return {
    ok: true,
    plan: {
      id: metadata.id || createTaskBoardId(),
      sourcePrompt: metadata.sourcePrompt,
      createdAt: metadata.createdAt || new Date().toISOString(),
      model: metadata.model,
      activeSkillIds: metadata.activeSkillIds,
      items,
      warnings: stringList(record.warnings)
    }
  };
}

export function buildTaskBoardExecutionPrompt(plan: TaskBoardPlan, language: AppLanguage) {
  const instruction = language === "zh"
    ? "请按下面的任务板执行。优先尊重依赖关系；如果运行时无法真实并行，就按依赖顺序串行执行，同时保留每个任务的 Agent 角色语义。完成后汇总每个任务的结果、验证和剩余风险。"
    : "Execute using the task board below. Respect dependencies first; if the runtime cannot run true parallel sub-agents, execute serially while preserving each task's agent role intent. Finish with each task's result, verification, and remaining risk.";
  return [
    instruction,
    "",
    "Original user request:",
    plan.sourcePrompt,
    "",
    "Task board JSON:",
    "```json",
    JSON.stringify({
      id: plan.id,
      items: plan.items.map((item) => ({
        id: item.id,
        title: item.title,
        goal: item.goal,
        agentRole: item.agentRole,
        dependencies: item.dependencies,
        targetAreas: item.targetAreas,
        acceptance: item.acceptance
      })),
      warnings: plan.warnings
    }, null, 2),
    "```"
  ].join("\n");
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function agentMatchesItem(agent: RuntimeAgent, item: TaskBoardItem) {
  const haystack = normalizeSearchText([agent.id, agent.name, agent.summary].join(" "));
  if (haystack.includes(normalizeSearchText(item.id))) return true;
  const title = normalizeSearchText(item.title);
  return title.length >= 4 && haystack.includes(title);
}

function statusFromAgent(agent: RuntimeAgent): TaskBoardItem["status"] {
  if (agent.status === "cancelled") return "blocked";
  return agent.status;
}

export function applyRuntimeStatusToTaskBoard(
  plan: TaskBoardPlan,
  agents: RuntimeAgent[] = [],
  turns: RuntimeTurn[] = []
): TaskBoardPlan {
  const items = plan.items.map((item) => ({ ...item }));
  const roleCounts = new Map<TaskAgentRole, number>();
  for (const item of items) {
    roleCounts.set(item.agentRole, (roleCounts.get(item.agentRole) || 0) + 1);
  }

  for (const item of items) {
    const exact = agents.find((agent) => agentMatchesItem(agent, item));
    const uniqueRole = roleCounts.get(item.agentRole) === 1
      ? agents.find((agent) => agent.type === item.agentRole)
      : undefined;
    const matched = exact || uniqueRole;
    if (matched) {
      item.status = statusFromAgent(matched);
    }
  }

  const activeTurn = turns.find((turn) => turn.status === "running" || turn.status === "queued" || turn.status === "cancelling");
  if (activeTurn && agents.length === 0) {
    const runningItem = items.find((item) => item.status === "running");
    if (!runningItem) {
      const firstRunnable = items.find((item) => item.dependencies.length === 0 && item.status === "draft") || items.find((item) => item.status === "draft");
      if (firstRunnable) {
        firstRunnable.status = activeTurn.status === "queued" ? "queued" : "running";
      }
    }
    for (const item of items) {
      if (item.status === "draft") item.status = "queued";
    }
  }

  return { ...plan, items };
}
