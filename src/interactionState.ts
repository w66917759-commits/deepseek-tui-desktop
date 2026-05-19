export type InteractionPhase =
  | "ready"
  | "routing"
  | "queued"
  | "running"
  | "streaming"
  | "waiting_user_input"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale_running";

export type InteractionSeverity = "neutral" | "info" | "success" | "warning" | "danger";

export interface InteractionCapabilityIssue {
  id: string;
  state: string;
  reason: string;
}

export interface InteractionState {
  phase: InteractionPhase;
  severity: InteractionSeverity;
  reason: string;
  action: string;
  detail: string;
  canSubmit: boolean;
  canStop: boolean;
  stale: boolean;
  lastActivityAt: string;
  capabilityIssue: InteractionCapabilityIssue | null;
}

export interface InteractionRuntimeTurn {
  status?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  output?: string;
}

export interface InteractionRuntimeApiTurn {
  status?: string;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
}

export interface InteractionRuntimeItem {
  kind?: string;
  status?: string;
  started_at?: string | null;
  ended_at?: string | null;
  summary?: string | null;
  detail?: string | null;
}

export interface InteractionRuntimeEvent {
  at?: string;
}

export interface InteractionRuntimeSnapshot {
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  events?: InteractionRuntimeEvent[];
}

export interface InteractionRuntimeApiStatus {
  state?: string;
  connected?: boolean;
  updatedAt?: string;
  error?: string;
  pendingApprovals?: unknown[];
  pendingUserInputs?: unknown[];
}

export interface InteractionCapabilityState {
  id?: string;
  name?: string;
  selected?: boolean;
  enabled?: boolean;
  callable?: boolean;
  failed?: boolean;
  approvalBlocked?: boolean;
  state?: string;
  reason?: string;
  runtimeState?: {
    selected?: boolean;
    enabled?: boolean;
    callable?: boolean;
    failed?: boolean;
    approvalBlocked?: boolean;
    state?: string;
    reason?: string;
  } | null;
}

export interface DeriveInteractionStateOptions {
  hasApiKey?: boolean;
  workspacePath?: string;
  prompt?: string;
  statusType?: string;
  statusMessage?: string;
  isRouting?: boolean;
  activeTerminalRunning?: boolean;
  activeRuntimeTurns?: InteractionRuntimeTurn[];
  runtimeApiTurns?: InteractionRuntimeApiTurn[];
  runtimeItems?: InteractionRuntimeItem[];
  runtimeSnapshot?: InteractionRuntimeSnapshot | null;
  runtimeApiStatus?: InteractionRuntimeApiStatus | null;
  runtimeEvents?: InteractionRuntimeEvent[];
  selectedCapabilities?: InteractionCapabilityState[];
  processStreamEnabled?: boolean;
  nowMs?: number;
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000;
const STREAMING_WINDOW_MS = 15 * 1000;
const ACTIVE_RUNTIME_STATUSES = new Set(["running", "cancelling", "in_progress"]);
const WAITING_USER_INPUT_STATUSES = new Set(["waiting_user_input"]);
const PENDING_ITEM_STATUSES = new Set(["queued", "in_progress"]);

function parseTimeMs(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoFromMs(value: number) {
  return value > 0 ? new Date(value).toISOString() : "";
}

function collectTimestamp(timestamps: number[], value: string | number | null | undefined) {
  const parsed = parseTimeMs(value);
  if (parsed > 0) timestamps.push(parsed);
}

function latestActivityMs(options: DeriveInteractionStateOptions) {
  const timestamps: number[] = [];
  for (const event of options.runtimeEvents || []) collectTimestamp(timestamps, event.at);
  for (const event of options.runtimeSnapshot?.events || []) collectTimestamp(timestamps, event.at);
  collectTimestamp(timestamps, options.runtimeSnapshot?.startedAt);
  collectTimestamp(timestamps, options.runtimeSnapshot?.updatedAt);
  for (const turn of options.activeRuntimeTurns || []) {
    collectTimestamp(timestamps, turn.queuedAt);
    collectTimestamp(timestamps, turn.startedAt);
    collectTimestamp(timestamps, turn.completedAt);
  }
  for (const turn of options.runtimeApiTurns || []) {
    collectTimestamp(timestamps, turn.created_at);
    collectTimestamp(timestamps, turn.started_at || undefined);
    collectTimestamp(timestamps, turn.ended_at || undefined);
  }
  for (const item of options.runtimeItems || []) {
    collectTimestamp(timestamps, item.started_at || undefined);
    collectTimestamp(timestamps, item.ended_at || undefined);
  }
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

function hasPendingItem(items: InteractionRuntimeItem[], kind: string) {
  return items.some((item) => item.kind === kind && PENDING_ITEM_STATUSES.has(String(item.status || "")));
}

function findCapabilityIssue(capabilities: InteractionCapabilityState[] | undefined): InteractionCapabilityIssue | null {
  for (const capability of capabilities || []) {
    const runtimeState = capability.runtimeState || {};
    const selected = Boolean(runtimeState.selected ?? capability.selected ?? capability.enabled);
    if (!selected) continue;
    const state = String(runtimeState.state || capability.state || "");
    const callable = Boolean(runtimeState.callable ?? capability.callable);
    const failed = Boolean(runtimeState.failed ?? capability.failed);
    const approvalBlocked = Boolean(runtimeState.approvalBlocked ?? capability.approvalBlocked);
    if (callable && !failed && !approvalBlocked) continue;
    if (state === "callable" && !failed && !approvalBlocked) continue;
    return {
      id: String(capability.name || capability.id || "capability"),
      state: state || (failed ? "failed" : approvalBlocked ? "approval_blocked" : "not_callable"),
      reason: String(runtimeState.reason || capability.reason || "")
    };
  }
  return null;
}

function buildState(
  options: DeriveInteractionStateOptions,
  phase: InteractionPhase,
  severity: InteractionSeverity,
  reason: string,
  action: string,
  detail: string,
  canStop: boolean,
  hardBlock = false
): InteractionState {
  const promptReady = Boolean(String(options.prompt || "").trim());
  const lastActivityMs = latestActivityMs(options);
  const capabilityIssue = findCapabilityIssue(options.selectedCapabilities);
  const activePhase = phase === "routing"
    || phase === "queued"
    || phase === "running"
    || phase === "streaming"
    || phase === "waiting_user_input"
    || phase === "waiting_approval"
    || phase === "stale_running";
  const warningSeverity = severity === "neutral" && capabilityIssue ? "warning" : severity;
  const warningDetail = !detail && capabilityIssue
    ? `${capabilityIssue.id}: ${capabilityIssue.reason || capabilityIssue.state}`
    : detail;
  return {
    phase,
    severity: warningSeverity,
    reason,
    action,
    detail: warningDetail,
    canSubmit: promptReady && !activePhase && !hardBlock,
    canStop,
    stale: phase === "stale_running",
    lastActivityAt: isoFromMs(lastActivityMs),
    capabilityIssue
  };
}

export function deriveInteractionState(options: DeriveInteractionStateOptions): InteractionState {
  const activeRuntimeTurns = options.activeRuntimeTurns || [];
  const runtimeApiTurns = options.runtimeApiTurns || [];
  const runtimeItems = options.runtimeItems || [];
  const runtimeApiStatus = options.runtimeApiStatus || null;
  const statusType = String(options.statusType || "ready");

  if (options.hasApiKey === false) {
    return buildState(options, "blocked", "danger", "missing_api_key", "set_api_key", "", false, true);
  }

  if (options.workspacePath !== undefined && !String(options.workspacePath).trim()) {
    return buildState(options, "blocked", "danger", "missing_workspace", "choose_workspace", "", false, true);
  }

  if (runtimeApiStatus?.state === "error" && runtimeApiStatus.connected === false) {
    return buildState(
      options,
      "failed",
      "danger",
      "runtime_api_unavailable",
      "restart_runtime_api",
      runtimeApiStatus.error || "",
      false,
      true
    );
  }

  const pendingUserInputs = runtimeApiStatus?.pendingUserInputs?.length || 0;
  const pendingApprovals = runtimeApiStatus?.pendingApprovals?.length || 0;
  const hasWaitingUserInput = pendingUserInputs > 0
    || runtimeApiTurns.some((turn) => WAITING_USER_INPUT_STATUSES.has(String(turn.status || "")))
    || hasPendingItem(runtimeItems, "user_input_request");
  if (hasWaitingUserInput) {
    return buildState(
      options,
      "waiting_user_input",
      "warning",
      "waiting_user_input",
      "answer_runtime_question",
      pendingUserInputs > 0 ? String(pendingUserInputs) : "",
      true
    );
  }

  const hasWaitingApproval = pendingApprovals > 0 || hasPendingItem(runtimeItems, "approval_request");
  if (hasWaitingApproval) {
    return buildState(
      options,
      "waiting_approval",
      "warning",
      "waiting_approval",
      "decide_runtime_approval",
      pendingApprovals > 0 ? String(pendingApprovals) : "",
      true
    );
  }

  const queued = activeRuntimeTurns.some((turn) => turn.status === "queued")
    || runtimeApiTurns.some((turn) => turn.status === "queued");
  if (queued) {
    return buildState(options, "queued", "info", "turn_queued", "wait", "", true);
  }

  const running = Boolean(options.activeTerminalRunning)
    || options.runtimeSnapshot?.status === "running"
    || activeRuntimeTurns.some((turn) => ACTIVE_RUNTIME_STATUSES.has(String(turn.status || "")))
    || runtimeApiTurns.some((turn) => ACTIVE_RUNTIME_STATUSES.has(String(turn.status || "")));
  if (running) {
    const nowMs = options.nowMs || Date.now();
    const lastActivity = latestActivityMs(options);
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (lastActivity > 0 && nowMs - lastActivity > staleAfterMs) {
      return buildState(options, "stale_running", "warning", "running_without_recent_output", "check_runtime", "", true);
    }
    if (options.processStreamEnabled && lastActivity > 0 && nowMs - lastActivity <= STREAMING_WINDOW_MS) {
      return buildState(options, "streaming", "info", "streaming_output", "wait", "", true);
    }
    return buildState(options, "running", "info", "runtime_running", "wait", "", true);
  }

  if (options.isRouting || statusType === "launching") {
    return buildState(options, "routing", "info", "routing_runtime", "wait", "", false);
  }

  if (statusType === "error") {
    return buildState(options, "failed", "danger", "runtime_failed", "retry", options.statusMessage || "", false);
  }

  if (statusType === "stopped") {
    return buildState(options, "cancelled", "neutral", "runtime_cancelled", "retry", "", false);
  }

  if (statusType === "exited") {
    return buildState(options, "completed", "success", "runtime_completed", "send_next", "", false);
  }

  return buildState(options, "ready", "neutral", "ready", "send", "", false);
}
