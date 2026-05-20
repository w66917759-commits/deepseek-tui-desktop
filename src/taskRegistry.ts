export interface TaskBoardItemPromptOptions {
  plan: TaskBoardPlan;
  item: TaskBoardItem;
  language: AppLanguage;
  capabilityContext?: string;
}

const VALID_ITEM_STATUSES = new Set<TaskBoardItem["status"]>([
  "draft",
  "queued",
  "running",
  "completed",
  "failed",
  "blocked"
]);
const ACTIVE_RUNTIME_STATUSES = new Set<RuntimeApiTurnStatus>(["queued", "in_progress", "waiting_user_input"]);
const FAILED_RUNTIME_STATUSES = new Set<RuntimeApiTurnStatus>(["failed", "interrupted", "canceled"]);
const DEPENDENCY_BLOCK_PREFIX = "Blocked by dependency:";

function stringValue(value: unknown) {
  return String(value || "").trim();
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function normalizeStatus(value: unknown): TaskBoardItem["status"] {
  const status = stringValue(value).toLowerCase();
  return VALID_ITEM_STATUSES.has(status as TaskBoardItem["status"])
    ? status as TaskBoardItem["status"]
    : "draft";
}

function maxIso(values: Array<string | null | undefined>) {
  let maxMs = 0;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > maxMs) maxMs = parsed;
  }
  return maxMs > 0 ? new Date(maxMs).toISOString() : "";
}

function trimSummary(value: string, maxLength = 700) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function normalizeItem(candidate: unknown, index: number): TaskBoardItem | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const item = candidate as Partial<TaskBoardItem>;
  const id = stringValue(item.id) || `task-${index + 1}`;
  const title = stringValue(item.title);
  const goal = stringValue(item.goal);
  const agentRole = stringValue(item.agentRole) as TaskAgentRole;
  if (!title || !goal || !agentRole) return null;
  return {
    id,
    title,
    goal,
    agentRole,
    dependencies: stringList(item.dependencies),
    targetAreas: stringList(item.targetAreas),
    acceptance: stringList(item.acceptance),
    status: normalizeStatus(item.status),
    runId: stringValue(item.runId) || undefined,
    runtimeThreadId: stringValue(item.runtimeThreadId) || undefined,
    runtimeTurnId: stringValue(item.runtimeTurnId) || undefined,
    blockedReason: stringValue(item.blockedReason) || undefined,
    outputSummary: stringValue(item.outputSummary) || undefined,
    lastActivityAt: stringValue(item.lastActivityAt) || undefined,
    completedAt: stringValue(item.completedAt) || undefined
  };
}

export function normalizeTaskBoardPlan(candidate: unknown): TaskBoardPlan | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const board = candidate as Partial<TaskBoardPlan>;
  const items = Array.isArray(board.items)
    ? board.items.map((item, index) => normalizeItem(item, index)).filter((item): item is TaskBoardItem => Boolean(item))
    : [];
  if (!stringValue(board.id) || !stringValue(board.sourcePrompt) || items.length === 0) return null;
  return {
    id: stringValue(board.id),
    sourcePrompt: stringValue(board.sourcePrompt),
    createdAt: stringValue(board.createdAt) || new Date(0).toISOString(),
    model: stringValue(board.model),
    activeSkillIds: stringList(board.activeSkillIds),
    items,
    warnings: stringList(board.warnings)
  };
}

export function normalizeTaskBoardPlans(value: unknown): TaskBoardPlan[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => normalizeTaskBoardPlan(candidate)).filter((plan): plan is TaskBoardPlan => Boolean(plan));
}

export function createTaskBoardRunId(boardId: string) {
  return `taskrun-${boardId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dependencyIssues(plan: TaskBoardPlan, item: TaskBoardItem) {
  const byId = new Map(plan.items.map((candidate) => [candidate.id, candidate]));
  for (const dependencyId of item.dependencies) {
    const dependency = byId.get(dependencyId);
    if (!dependency) return { dependencyId, status: "missing" };
    if (dependency.status === "failed" || dependency.status === "blocked") {
      return { dependencyId, status: dependency.status };
    }
    if (dependency.status !== "completed") {
      return { dependencyId, status: dependency.status };
    }
  }
  return null;
}

function canRunItem(plan: TaskBoardPlan, item: TaskBoardItem) {
  if (item.status !== "draft" && item.status !== "queued") return false;
  return dependencyIssues(plan, item) === null;
}

export function propagateBlockedTaskItems(plan: TaskBoardPlan): TaskBoardPlan {
  let items = plan.items.map((item) => ({ ...item }));
  let changed = true;
  while (changed) {
    changed = false;
    const workingPlan = { ...plan, items };
    items = items.map((item) => {
      if (item.status === "completed" || item.status === "failed" || item.status === "running" || item.status === "queued") {
        return item;
      }
      const issue = dependencyIssues(workingPlan, item);
      if (issue && issue.status !== "draft" && issue.status !== "queued" && issue.status !== "running" && issue.status !== "completed") {
        const nextReason = `${DEPENDENCY_BLOCK_PREFIX} ${issue.dependencyId} is ${issue.status}.`;
        if (item.status !== "blocked" || item.blockedReason !== nextReason) {
          changed = true;
          return {
            ...item,
            status: "blocked",
            blockedReason: nextReason,
            lastActivityAt: new Date().toISOString()
          };
        }
      }
      if (!issue && item.status === "blocked" && item.blockedReason?.startsWith(DEPENDENCY_BLOCK_PREFIX)) {
        changed = true;
        return {
          ...item,
          status: "draft",
          blockedReason: undefined
        };
      }
      return item;
    });
  }
  return { ...plan, items };
}

export function runnableTaskBoardItems(plan: TaskBoardPlan) {
  const reconciled = propagateBlockedTaskItems(plan);
  return reconciled.items.filter((item) => canRunItem(reconciled, item));
}

export function nextRunnableTaskBoardItem(plan: TaskBoardPlan) {
  return runnableTaskBoardItems(plan)[0] || null;
}

export function taskBoardRunSummary(plan: TaskBoardPlan): TaskBoardRunSummary {
  const reconciled = propagateBlockedTaskItems(plan);
  const summary: TaskBoardRunSummary = {
    boardId: reconciled.id,
    total: reconciled.items.length,
    draft: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    runnable: runnableTaskBoardItems(reconciled).length,
    nextItemId: nextRunnableTaskBoardItem(reconciled)?.id || "",
    activeRunId: "",
    lastActivityAt: "",
    completedAt: ""
  };
  const activity: string[] = [];
  const completed: string[] = [];
  for (const item of reconciled.items) {
    summary[item.status] += 1;
    if (!summary.activeRunId && item.runId && (item.status === "queued" || item.status === "running")) summary.activeRunId = item.runId;
    if (item.lastActivityAt) activity.push(item.lastActivityAt);
    if (item.completedAt) completed.push(item.completedAt);
  }
  summary.lastActivityAt = maxIso(activity);
  summary.completedAt = summary.completed === summary.total ? maxIso(completed) : "";
  return summary;
}

export function queueTaskBoardItem(plan: TaskBoardPlan, itemId: string, runId: string): TaskBoardPlan {
  return {
    ...plan,
    items: plan.items.map((item) => item.id === itemId
      ? {
        ...item,
        runId,
        status: "queued",
        blockedReason: undefined,
        lastActivityAt: new Date().toISOString()
      }
      : item)
  };
}

export function bindTaskBoardItemRuntime(
  plan: TaskBoardPlan,
  itemId: string,
  threadId: string,
  turnId?: string
): TaskBoardPlan {
  return {
    ...plan,
    items: plan.items.map((item) => item.id === itemId
      ? {
        ...item,
        runtimeThreadId: threadId,
        runtimeTurnId: turnId || item.runtimeTurnId,
        status: "running",
        lastActivityAt: new Date().toISOString()
      }
      : item)
  };
}

export function resetTaskBoardItemForRetry(plan: TaskBoardPlan, itemId: string): TaskBoardPlan {
  return {
    ...plan,
    items: plan.items.map((item) => item.id === itemId
      ? {
        ...item,
        status: "draft",
        runId: undefined,
        runtimeThreadId: undefined,
        runtimeTurnId: undefined,
        blockedReason: undefined,
        outputSummary: undefined,
        lastActivityAt: undefined,
        completedAt: undefined
      }
      : item)
  };
}

function latestTurn(detail: RuntimeApiThreadDetail, preferredTurnId?: string) {
  if (preferredTurnId) {
    const exact = detail.turns.find((turn) => turn.id === preferredTurnId);
    if (exact) return exact;
  }
  return detail.turns.at(-1) || null;
}

function itemsForTurn(detail: RuntimeApiThreadDetail, turn: RuntimeApiTurnRecord) {
  const itemIds = new Set(turn.item_ids || []);
  return detail.items.filter((item) => item.turn_id === turn.id || itemIds.has(item.id));
}

function outputSummaryFromRuntime(detail: RuntimeApiThreadDetail, turn: RuntimeApiTurnRecord) {
  const turnItems = itemsForTurn(detail, turn);
  const assistantItem = [...turnItems].reverse().find((item) => item.kind === "agent_message" && (item.detail || item.summary));
  if (assistantItem) return trimSummary(String(assistantItem.detail || assistantItem.summary || ""));
  const errorItem = [...turnItems].reverse().find((item) => item.kind === "error" && (item.detail || item.summary));
  if (errorItem) return trimSummary(String(errorItem.detail || errorItem.summary || ""));
  return trimSummary(String(turn.error || turn.input_summary || ""));
}

function pendingBlockReason(detail: RuntimeApiThreadDetail, turn: RuntimeApiTurnRecord) {
  const pending = itemsForTurn(detail, turn).find((item) => (
    (item.kind === "approval_request" || item.kind === "user_input_request")
    && (item.status === "queued" || item.status === "in_progress")
  ));
  if (!pending) return "";
  return pending.kind === "approval_request" ? "Runtime approval is required." : "Runtime user input is required.";
}

function runtimeActivityAt(detail: RuntimeApiThreadDetail, turn: RuntimeApiTurnRecord) {
  const turnItems = itemsForTurn(detail, turn);
  return maxIso([
    detail.thread.updated_at,
    turn.ended_at || undefined,
    turn.started_at || undefined,
    turn.created_at,
    ...turnItems.flatMap((item) => [item.ended_at || undefined, item.started_at || undefined])
  ]);
}

export function applyTaskRuntimeDetail(
  plan: TaskBoardPlan,
  itemId: string,
  detail: RuntimeApiThreadDetail
): TaskBoardPlan {
  const items = plan.items.map((item) => ({ ...item }));
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return plan;
  const item = items[index];
  const turn = latestTurn(detail, item.runtimeTurnId);
  if (!turn) return plan;

  const pendingReason = pendingBlockReason(detail, turn);
  const lastActivityAt = runtimeActivityAt(detail, turn) || new Date().toISOString();
  const outputSummary = outputSummaryFromRuntime(detail, turn) || item.outputSummary;
  const nextItem: TaskBoardItem = {
    ...item,
    runtimeThreadId: detail.thread.id,
    runtimeTurnId: turn.id,
    lastActivityAt,
    outputSummary
  };

  if (turn.status === "completed") {
    nextItem.status = "completed";
    nextItem.blockedReason = undefined;
    nextItem.completedAt = turn.ended_at || lastActivityAt;
  } else if (FAILED_RUNTIME_STATUSES.has(turn.status)) {
    nextItem.status = "failed";
    nextItem.blockedReason = stringValue(turn.error) || `Runtime turn ${turn.status}.`;
    nextItem.completedAt = turn.ended_at || lastActivityAt;
  } else if (turn.status === "waiting_user_input" || pendingReason) {
    nextItem.status = "blocked";
    nextItem.blockedReason = pendingReason || "Runtime user input is required.";
  } else if (ACTIVE_RUNTIME_STATUSES.has(turn.status)) {
    nextItem.status = turn.status === "queued" ? "queued" : "running";
    nextItem.blockedReason = undefined;
  }

  items[index] = nextItem;
  return propagateBlockedTaskItems({ ...plan, items });
}

export function applyTaskBoardRuntimeDetails(
  plan: TaskBoardPlan,
  detailsByThreadId: Record<string, RuntimeApiThreadDetail>
): TaskBoardPlan {
  let nextPlan = normalizeTaskBoardPlan(plan) || plan;
  for (const item of nextPlan.items) {
    if (!item.runtimeThreadId) continue;
    const detail = detailsByThreadId[item.runtimeThreadId];
    if (detail) nextPlan = applyTaskRuntimeDetail(nextPlan, item.id, detail);
  }
  return propagateBlockedTaskItems(nextPlan);
}

function dependencySummaries(plan: TaskBoardPlan, item: TaskBoardItem) {
  if (item.dependencies.length === 0) return [];
  const byId = new Map(plan.items.map((candidate) => [candidate.id, candidate]));
  return item.dependencies.map((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return {
      id: dependencyId,
      title: dependency?.title || dependencyId,
      status: dependency?.status || "missing",
      outputSummary: dependency?.outputSummary || ""
    };
  });
}

export function buildTaskBoardItemExecutionPrompt(options: TaskBoardItemPromptOptions) {
  const dependencyOutputs = dependencySummaries(options.plan, options.item);
  const taskJson = {
    boardId: options.plan.id,
    itemId: options.item.id,
    title: options.item.title,
    goal: options.item.goal,
    agentRole: options.item.agentRole,
    dependencies: options.item.dependencies,
    dependencyOutputs,
    targetAreas: options.item.targetAreas,
    acceptance: options.item.acceptance,
    warnings: options.plan.warnings
  };
  const instruction = options.language === "zh"
    ? "你正在执行任务板中的单个任务 item。只完成当前 item；依赖输出只作为上下文，不要主动执行其他 item。完成后用简短摘要说明结果、验证和剩余风险。"
    : "You are executing one task-board item. Complete only the current item; dependency outputs are context, not permission to execute other items. Finish with a concise summary of result, verification, and remaining risk.";
  return [
    instruction,
    "",
    options.capabilityContext ? options.capabilityContext : "",
    options.capabilityContext ? "" : "",
    "Original user request:",
    options.plan.sourcePrompt,
    "",
    "Current task item:",
    "```json",
    JSON.stringify(taskJson, null, 2),
    "```"
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}
