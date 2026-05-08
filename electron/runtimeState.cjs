const { EventEmitter } = require("events");

const DEFAULT_MAX_EVENTS = 80;

function nowIso() {
  return new Date().toISOString();
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

function runtimeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "completed" || normalized === "complete" || normalized === "done") return "completed";
  if (normalized === "failed" || normalized === "failure" || normalized === "error") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "interrupted") return "cancelled";
  if (normalized === "queued") return "queued";
  return "running";
}

function stableAgentId(value) {
  return String(value || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent";
}

function countAgents(agents) {
  return agents.reduce((counts, agent) => {
    counts.total += 1;
    if (agent.status === "running" || agent.status === "queued") counts.running += 1;
    if (agent.status === "completed") counts.completed += 1;
    if (agent.status === "failed") counts.failed += 1;
    if (agent.status === "cancelled") counts.cancelled += 1;
    return counts;
  }, {
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  });
}

function settleActiveAgents(agents, status, timestamp) {
  return agents.map((agent) => {
    if (agent.status !== "running" && agent.status !== "queued") return agent;
    return {
      ...agent,
      status,
      updatedAt: timestamp
    };
  });
}

function emptySnapshot() {
  const timestamp = nowIso();
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
    updatedAt: timestamp,
    lastExit: null,
    agents: [],
    counts: countAgents([]),
    events: []
  };
}

function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

class DeepSeekRuntimeState extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxEvents = Number(options.maxEvents) || DEFAULT_MAX_EVENTS;
    this.sequence = 0;
    this.state = emptySnapshot();
  }

  snapshot() {
    return cloneSnapshot(this.state);
  }

  startRun(plan = {}) {
    const timestamp = nowIso();
    this.state = {
      ...emptySnapshot(),
      status: "running",
      source: "pty",
      sessionId: String(plan.sessionId || ""),
      mode: String(plan.mode || plan.launchAction || ""),
      workspacePath: String(plan.workspacePath || plan.cwd || ""),
      pid: Number(plan.pid || 0),
      command: String(plan.command || ""),
      args: Array.isArray(plan.args) ? plan.args.map(String) : [],
      startedAt: timestamp,
      updatedAt: timestamp
    };
    this.addEvent("run-started", "Run started", this.state.mode || this.state.command);
    this.emitSnapshot();
  }

  finishRun(exit = {}) {
    const timestamp = nowIso();
    const failed = exit.signal || (typeof exit.exitCode === "number" && exit.exitCode !== 0);
    const agents = settleActiveAgents(this.state.agents, failed ? "cancelled" : "completed", timestamp);
    this.state = {
      ...this.state,
      status: failed ? "failed" : "completed",
      updatedAt: timestamp,
      agents,
      counts: countAgents(agents),
      lastExit: {
        exitCode: typeof exit.exitCode === "number" ? exit.exitCode : 0,
        signal: exit.signal || "",
        exitedAt: exit.exitedAt || timestamp
      }
    };
    this.addEvent("run-exit", failed ? "Run failed" : "Run completed", `exitCode=${this.state.lastExit.exitCode}`);
    this.emitSnapshot();
  }

  stopRun() {
    if (this.state.status === "idle") return;
    const timestamp = nowIso();
    const agents = settleActiveAgents(this.state.agents, "cancelled", timestamp);
    this.state = {
      ...this.state,
      status: "stopped",
      updatedAt: timestamp,
      agents,
      counts: countAgents(agents)
    };
    this.addEvent("run-stopped", "Run stopped", "");
    this.emitSnapshot();
  }

  ingestTerminalData(data) {
    const clean = stripAnsi(data);
    if (!clean.trim()) return [];

    const eventsBefore = this.state.events.length;
    const agents = parseTerminalAgents(clean);
    if (agents.length > 0) {
      this.mergeAgents(agents, "pty");
      this.addEvent("agents", "Sub-agents updated", `${agents.length} agent${agents.length === 1 ? "" : "s"}`);
    } else if (/\bsub-agents?\b/i.test(clean)) {
      this.addEvent("agents", "Sub-agent activity observed", "");
    }

    if (eventsBefore !== this.state.events.length) {
      this.emitSnapshot();
    }
    return this.state.events.slice(eventsBefore);
  }

  ingestRuntimeEvent(frame = {}) {
    if (!frame || typeof frame !== "object") return null;
    const eventName = String(frame.event || frame.type || "runtime-event");
    const label = runtimeEventLabel(eventName);

    if (Array.isArray(frame.agents)) {
      this.mergeAgents(frame.agents.map((agent) => ({
        id: agent.id || agent.name,
        name: agent.name || agent.id,
        status: agent.status,
        summary: agent.summary || agent.detail || agent.message || ""
      })), "runtime-api");
    }

    if (eventName === "turn_started" || eventName === "response_start") {
      this.state.status = "running";
    }
    if (eventName === "turn_completed" || eventName === "response_end") {
      this.state.status = "completed";
    }
    if (eventName === "turn_aborted" || eventName === "error") {
      this.state.status = "failed";
    }

    const event = this.addEvent(eventName, label, frame.message || frame.summary || "");
    this.emitSnapshot();
    return event;
  }

  mergeAgents(nextAgents, source) {
    const timestamp = nowIso();
    const existing = new Map(this.state.agents.map((agent) => [agent.id, agent]));
    for (const candidate of nextAgents) {
      const id = stableAgentId(candidate.id || candidate.name);
      const previous = existing.get(id);
      existing.set(id, {
        id,
        name: String(candidate.name || candidate.id || id),
        status: runtimeStatus(candidate.status),
        summary: String(candidate.summary || ""),
        source,
        updatedAt: timestamp,
        createdAt: previous?.createdAt || timestamp
      });
    }
    const agents = Array.from(existing.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.state = {
      ...this.state,
      source,
      agents,
      counts: countAgents(agents),
      updatedAt: timestamp
    };
  }

  addEvent(type, label, detail) {
    const event = {
      id: `evt-${++this.sequence}`,
      type,
      label,
      detail: String(detail || ""),
      at: nowIso()
    };
    this.state = {
      ...this.state,
      events: [...this.state.events, event].slice(-this.maxEvents),
      updatedAt: event.at
    };
    this.emit("runtime:event", event);
    return event;
  }

  emitSnapshot() {
    this.emit("runtime:snapshot", this.snapshot());
  }
}

function runtimeEventLabel(eventName) {
  return String(eventName || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    || "Runtime Event";
}

function parseTerminalAgents(text) {
  const agents = [];
  const clean = stripAnsi(text);
  const contextual = /\bsub-agents?\b/i.test(clean);
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = parseTerminalAgentLine(line, contextual);
    if (!match) continue;
    agents.push({
      id: match.id,
      name: match.name,
      status: match.status,
      summary: match.summary
    });
  }
  return agents;
}

function parseTerminalAgentLine(rawLine, contextual) {
  if (!rawLine || /\(no data\)/i.test(rawLine)) return null;
  let line = rawLine
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/^\d+\.\s*/, "");
  if (/^sub-agents?:\s*$/i.test(line)) return null;

  const explicit = line.match(/^(?:agent|sub-agent)\s+(.+)$/i);
  if (explicit) {
    line = explicit[1].trim();
    contextual = true;
  }
  if (!contextual) return null;

  const patterns = [
    /^([A-Za-z0-9_.:-]{2,80})\s+\[(Queued|Running|Completed|Failed|Cancelled|Canceled|Interrupted)\]\s*(.*)$/i,
    /^([A-Za-z0-9_.:-]{2,80})\s*:\s*(Queued|Running|Completed|Failed|Cancelled|Canceled|Interrupted)\b(.*)$/i,
    /^([A-Za-z0-9_.:-]{2,80})\s+(Queued|Running|Completed|Failed|Cancelled|Canceled|Interrupted)\b(.*)$/i
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) continue;
    const name = match[1].replace(/:+$/g, "");
    return {
      id: name,
      name,
      status: match[2],
      summary: String(match[3] || "").replace(/^[\s:-]+/, "")
    };
  }
  return null;
}

module.exports = {
  DeepSeekRuntimeState,
  parseTerminalAgents,
  stripAnsi
};
