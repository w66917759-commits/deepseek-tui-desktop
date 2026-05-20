export interface CapabilityRegistryInput {
  skills?: RuntimeApiSkill[];
  mcpServers?: RuntimeApiMcpServer[];
  settings?: Partial<DesktopSettings>;
}

const DEFAULT_RUNTIME_STATE: RuntimeCapabilityState = {
  selected: false,
  enabled: false,
  injected: false,
  loaded: false,
  callable: false,
  approvalBlocked: false,
  failed: false,
  state: "disabled",
  reason: ""
};

function stringValue(value: unknown) {
  return String(value || "").trim();
}

function runtimeStateFrom(
  source: RuntimeCapabilityState | undefined,
  fallback: Partial<RuntimeCapabilityState> = {}
): RuntimeCapabilityState {
  const selected = Boolean(source?.selected ?? fallback.selected ?? false);
  const enabled = Boolean(source?.enabled ?? fallback.enabled ?? selected);
  const injected = Boolean(source?.injected ?? fallback.injected ?? false);
  const loaded = Boolean(source?.loaded ?? fallback.loaded ?? false);
  const callable = Boolean(source?.callable ?? fallback.callable ?? false);
  const approvalBlocked = Boolean(source?.approvalBlocked ?? fallback.approvalBlocked ?? false);
  const failed = Boolean(source?.failed ?? fallback.failed ?? false);
  const state = String(source?.state || fallback.state || DEFAULT_RUNTIME_STATE.state) as RuntimeCapabilityState["state"];
  const reason = stringValue(source?.reason || fallback.reason);
  return {
    selected,
    enabled,
    injected,
    loaded,
    callable,
    approvalBlocked,
    failed,
    state,
    reason
  };
}

function desktopState(callable: boolean, reason = ""): RuntimeCapabilityState {
  return runtimeStateFrom(undefined, {
    selected: true,
    enabled: callable,
    injected: callable,
    loaded: callable,
    callable,
    failed: false,
    approvalBlocked: false,
    state: callable ? "callable" : "selected",
    reason
  });
}

function recordFromSkill(skill: RuntimeApiSkill): CapabilityRecord {
  const id = stringValue(skill.id || skill.name);
  const runtimeState = runtimeStateFrom(skill.runtimeState, {
    selected: Boolean(skill.enabled),
    enabled: Boolean(skill.enabled),
    state: skill.enabled ? "enabled" : "disabled",
    reason: skill.description || skill.path || ""
  });
  return {
    id: `skill:${id}`,
    kind: "skill",
    name: stringValue(skill.name || skill.id) || "Skill",
    description: stringValue(skill.description || skill.path),
    permission: "read-only",
    runtimeState,
    reason: runtimeState.reason,
    source: "runtime-api:skills"
  };
}

function recordFromMcpServer(server: RuntimeApiMcpServer): CapabilityRecord {
  const id = stringValue(server.id || server.name);
  const runtimeState = runtimeStateFrom(server.runtimeState, {
    selected: Boolean(server.enabled),
    enabled: Boolean(server.enabled),
    loaded: Boolean(server.connected),
    callable: Boolean(server.connected),
    failed: Boolean(server.error),
    state: server.connected ? "callable" : server.enabled ? "selected" : "disabled",
    reason: server.error || server.status || server.command || server.url || ""
  });
  return {
    id: `mcp:${id}`,
    kind: "mcp",
    name: stringValue(server.name || server.id) || "MCP",
    description: stringValue(server.command || server.url || server.status),
    permission: "danger-full-access",
    runtimeState,
    reason: runtimeState.reason,
    source: "runtime-api:mcp"
  };
}

export function desktopCapabilityRecords(settings: Partial<DesktopSettings> = {}): CapabilityRecord[] {
  const hasWorkspace = Boolean(stringValue(settings.workspacePath));
  const shellAllowed = settings.allowShell !== false;
  return [
    {
      id: "desktop:automation",
      kind: "desktop-tool",
      name: "Automation",
      description: "Create, update, install, and remove desktop automations.",
      permission: "workspace-write",
      runtimeState: desktopState(true),
      reason: "",
      source: "desktop"
    },
    {
      id: "desktop:git",
      kind: "desktop-tool",
      name: "Git",
      description: "Inspect and operate the selected workspace Git repository.",
      permission: "workspace-write",
      runtimeState: desktopState(hasWorkspace, hasWorkspace ? "" : "missing workspace"),
      reason: hasWorkspace ? "" : "missing workspace",
      source: "desktop"
    },
    {
      id: "desktop:editor",
      kind: "desktop-tool",
      name: "Editor",
      description: "Open the current workspace in a local editor.",
      permission: "workspace-write",
      runtimeState: desktopState(hasWorkspace, hasWorkspace ? "" : "missing workspace"),
      reason: hasWorkspace ? "" : "missing workspace",
      source: "desktop"
    },
    {
      id: "desktop:terminal",
      kind: "desktop-tool",
      name: "Terminal",
      description: "Start and control the integrated terminal.",
      permission: "danger-full-access",
      runtimeState: desktopState(hasWorkspace && shellAllowed, !hasWorkspace ? "missing workspace" : shellAllowed ? "" : "shell disabled"),
      reason: !hasWorkspace ? "missing workspace" : shellAllowed ? "" : "shell disabled",
      source: "desktop"
    },
    {
      id: "runtime-api:threads",
      kind: "runtime-api",
      name: "Runtime thread controls",
      description: "Create, resume, steer, interrupt, and inspect runtime API threads.",
      permission: "workspace-write",
      runtimeState: desktopState(hasWorkspace, hasWorkspace ? "" : "missing workspace"),
      reason: hasWorkspace ? "" : "missing workspace",
      source: "runtime-api"
    }
  ];
}

export function buildCapabilityRecords(input: CapabilityRegistryInput): CapabilityRecord[] {
  return [
    ...(input.skills || []).map(recordFromSkill),
    ...(input.mcpServers || []).map(recordFromMcpServer),
    ...desktopCapabilityRecords(input.settings)
  ];
}

function recordLabel(record: CapabilityRecord) {
  return `${record.name} (${record.kind}, ${record.permission})`;
}

export function callableCapabilityRecords(records: CapabilityRecord[]) {
  return records.filter((record) => record.runtimeState.callable && !record.runtimeState.failed && !record.runtimeState.approvalBlocked);
}

export function blockedSelectedCapabilityRecords(records: CapabilityRecord[]) {
  return records.filter((record) => {
    const state = record.runtimeState;
    return state.selected && (!state.callable || state.failed || state.approvalBlocked);
  });
}

export function buildCapabilityContext(records: CapabilityRecord[], language: AppLanguage = "en") {
  const callable = callableCapabilityRecords(records);
  const blocked = blockedSelectedCapabilityRecords(records);
  const lines: string[] = [];
  if (language === "zh") {
    lines.push("能力上下文：只把 callable 能力视为可用。");
    lines.push("可调用能力：");
  } else {
    lines.push("Capability context: only callable capabilities are available.");
    lines.push("Callable capabilities:");
  }
  if (callable.length === 0) {
    lines.push(language === "zh" ? "- 无" : "- none");
  } else {
    for (const record of callable) {
      lines.push(`- ${recordLabel(record)}${record.description ? `: ${record.description}` : ""}`);
    }
  }
  if (blocked.length > 0) {
    lines.push(language === "zh" ? "已选择但不可调用的能力限制：" : "Blocked selected capabilities:");
    for (const record of blocked) {
      const reason = record.reason || record.runtimeState.reason || record.runtimeState.state;
      lines.push(`- ${record.name}: ${record.runtimeState.state}${reason ? ` - ${reason}` : ""}`);
    }
  }
  return lines.join("\n");
}
