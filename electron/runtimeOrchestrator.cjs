const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const CONTROL_DELTAS = new Set(["queued", "accepted", "running", "idle", "model-selected"]);

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function isControlDelta(delta) {
  return CONTROL_DELTAS.has(String(delta || "").trim().toLowerCase());
}

function defaultPlanPrompt(prompt) {
  return [
    "You are in Plan mode. Produce a concrete implementation plan only.",
    "Do not edit files, do not run destructive commands, and do not make external changes.",
    "Focus on steps, risks, required tools, and verification.",
    "",
    prompt || ""
  ].join("\n");
}

function buildDefaultDeepSeekArgs(turn, conversation, defaultCwd) {
  const args = [];
  if (turn.provider) args.push("--provider", turn.provider);
  if (turn.model) args.push("--model", turn.model);
  if (turn.baseUrl) args.push("--base-url", turn.baseUrl);
  args.push("--skip-onboarding", "--no-alt-screen", "--telemetry", "false");

  const workspacePath = conversation.workspacePath || defaultCwd;
  if (turn.mode === "yolo") {
    args.push("run", "--workspace", workspacePath, "--yolo", "-p", turn.prompt);
    return args;
  }
  if (turn.mode === "plan") {
    args.push("exec", "--auto", defaultPlanPrompt(turn.prompt));
    return args;
  }
  args.push("exec", "--auto", turn.prompt);
  return args;
}

function createDeepSeekCliRunner(options = {}) {
  const command = options.command || "";
  const configuredArgs = Array.isArray(options.args) ? options.args.map(String).filter(Boolean) : null;
  const env = { ...process.env, ...(options.env || {}) };
  const defaultCwd = options.cwd || process.cwd();

  return function runDeepSeekCliTurn(turn, conversation, emitEvent) {
    return new Promise((resolve, reject) => {
      if (!command) {
        reject(new Error("DeepSeek runtime command is not configured."));
        return;
      }

      const args = configuredArgs
        ? [...configuredArgs]
        : buildDefaultDeepSeekArgs(turn, conversation, defaultCwd);

      const child = spawn(command, args, {
        cwd: conversation.workspacePath || defaultCwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";
      turn.cancelRunner = () => child.kill();

      emitEvent({ event: "response_start", response_id: turn.turnId });
      child.stdout.on("data", (data) => {
        const chunk = String(data || "");
        stdout += chunk;
        emitEvent({ event: "response_delta", response_id: turn.turnId, delta: chunk });
      });
      child.stderr.on("data", (data) => {
        const chunk = String(data || "");
        stderr += chunk;
        emitEvent({ event: "runtime_stderr", response_id: turn.turnId, message: chunk });
      });
      child.on("error", (error) => {
        turn.cancelRunner = null;
        reject(error);
      });
      child.on("close", (code, signal) => {
        turn.cancelRunner = null;
        emitEvent({ event: "response_end", response_id: turn.turnId });
        if (turn.cancelled) {
          resolve({ output: stripAnsi(stdout), cancelled: true });
          return;
        }
        if (code === 0) {
          resolve({ output: stripAnsi(stdout) });
          return;
        }
        reject(new Error(stripAnsi(stderr) || `DeepSeek runtime exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}.`));
      });
    });
  };
}

function turnPublicView(turn) {
  return {
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    threadId: turn.threadId || "",
    status: turn.status,
    prompt: turn.prompt,
    output: turn.output,
    error: turn.error,
    queuedAt: turn.queuedAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    replyMessageId: turn.replyMessageId || "",
    queuePosition: turn.queuePosition || 0
  };
}

function conversationPublicView(conversation) {
  return {
    conversationId: conversation.conversationId,
    workspacePath: conversation.workspacePath,
    threadId: conversation.threadId || "",
    activeTurnId: conversation.activeTurnId || "",
    queuedTurnIds: [...conversation.queuedTurnIds],
    status: conversation.status,
    updatedAt: conversation.updatedAt
  };
}

class RuntimeOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.client = options.client;
    this.maxConcurrentSessions = Math.max(
      1,
      Number(options.maxConcurrentSessions || options.maxConcurrent) || DEFAULT_MAX_CONCURRENT_SESSIONS
    );
    this.maxConcurrent = this.maxConcurrentSessions;
    this.conversations = new Map();
    this.turns = new Map();
    this.globalQueue = [];
    this.runningTurnIds = new Set();
    this.runner = typeof options.runner === "function" ? options.runner : null;
    this.events = [];
    this.maxEvents = Number(options.maxEvents) || 120;
  }

  startTurn(payload = {}) {
    const conversationId = String(payload.conversationId || "").trim();
    const prompt = String(payload.prompt || "").trim();
    if (!conversationId) {
      return { ok: false, error: "conversationId is required" };
    }
    if (!prompt) {
      return { ok: false, error: "prompt is required" };
    }

    const conversation = this.ensureConversation(conversationId, payload.workspacePath);
    const turn = {
      turnId: payload.turnId || createId("turn"),
      conversationId,
      threadId: conversation.threadId || "",
      workspacePath: conversation.workspacePath,
      prompt,
      model: payload.model || "",
      provider: payload.settings?.provider || payload.provider || "",
      baseUrl: payload.settings?.baseUrl || payload.baseUrl || "",
      mode: payload.mode || "",
      settings: payload.settings && typeof payload.settings === "object" ? { ...payload.settings } : {},
      replyMessageId: payload.replyMessageId || "",
      status: "queued",
      output: "",
      error: "",
      queuedAt: nowIso(),
      startedAt: "",
      completedAt: "",
      queuePosition: 0,
      cancelled: false
    };

    this.turns.set(turn.turnId, turn);
    conversation.queuedTurnIds.push(turn.turnId);
    conversation.status = conversation.activeTurnId ? "running" : "queued";
    conversation.updatedAt = nowIso();
    this.globalQueue.push(turn.turnId);
    this.reindexQueue();
    this.addEvent("turn-queued", "Turn queued", prompt.slice(0, 120), turn);
    this.emitSnapshot();
    this.pump();

    return {
      ok: true,
      queued: turn.status === "queued",
      turnId: turn.turnId,
      conversationId,
      threadId: conversation.threadId || "",
      snapshot: this.snapshot()
    };
  }

  cancelTurn(payload = {}) {
    const conversationId = String(payload.conversationId || "").trim();
    const turnId = String(payload.turnId || "").trim();
    let cancelled = 0;

    const shouldCancel = (turn) => {
      if (turnId && turn.turnId !== turnId) return false;
      if (conversationId && turn.conversationId !== conversationId) return false;
      return turn.status === "queued";
    };

    for (const turn of this.turns.values()) {
      if (!shouldCancel(turn)) continue;
      turn.status = "cancelled";
      turn.completedAt = nowIso();
      turn.queuePosition = 0;
      cancelled += 1;
      this.removeFromQueue(turn.turnId);
      const conversation = this.conversations.get(turn.conversationId);
      if (conversation) {
        conversation.queuedTurnIds = conversation.queuedTurnIds.filter((id) => id !== turn.turnId);
        conversation.status = conversation.activeTurnId ? "running" : conversation.queuedTurnIds.length ? "queued" : "idle";
        conversation.updatedAt = nowIso();
      }
      this.addEvent("turn-cancelled", "Turn cancelled", turn.prompt.slice(0, 120), turn);
    }

    for (const turn of this.turns.values()) {
      if (turn.status !== "running") continue;
      if (turnId && turn.turnId !== turnId) continue;
      if (conversationId && turn.conversationId !== conversationId) continue;
      turn.cancelled = true;
      turn.status = "cancelling";
      cancelled += 1;
      const conversation = this.conversations.get(turn.conversationId);
      if (conversation) {
        conversation.status = "cancelling";
        conversation.updatedAt = nowIso();
      }
      if (typeof turn.cancelRunner === "function") {
        turn.cancelRunner();
      }
      this.addEvent("turn-cancelling", "Turn cancellation requested", turn.prompt.slice(0, 120), turn);
    }

    this.reindexQueue();
    this.emitSnapshot();
    return { ok: cancelled > 0, cancelled, snapshot: this.snapshot() };
  }

  async archiveConversation(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation?.threadId) {
      return { ok: false, error: "Conversation has no app-server thread." };
    }
    return this.client.request("thread/archive", { thread_id: conversation.threadId });
  }

  async waitForIdle(options = {}) {
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_IDLE_TIMEOUT_MS;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const snapshot = this.snapshot();
      if (snapshot.counts.running === 0 && snapshot.counts.queued === 0 && snapshot.counts.cancelling === 0) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Runtime orchestrator did not become idle within ${timeoutMs}ms`);
  }

  snapshot() {
    const turns = Array.from(this.turns.values()).map(turnPublicView);
    const counts = turns.reduce((acc, turn) => {
      acc.total += 1;
      if (turn.status === "queued") acc.queued += 1;
      if (turn.status === "running") acc.running += 1;
      if (turn.status === "cancelling") acc.cancelling += 1;
      if (turn.status === "completed") acc.completed += 1;
      if (turn.status === "failed") acc.failed += 1;
      if (turn.status === "cancelled") acc.cancelled += 1;
      return acc;
    }, {
      total: 0,
      queued: 0,
      running: 0,
      cancelling: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    });

    return {
      status: counts.running > 0 || counts.cancelling > 0 ? "running" : counts.queued > 0 ? "queued" : "idle",
      maxConcurrent: this.maxConcurrentSessions,
      maxConcurrentSessions: this.maxConcurrentSessions,
      activeCount: this.runningTurnIds.size,
      queueDepth: this.globalQueue.length,
      counts,
      conversations: Array.from(this.conversations.values()).map(conversationPublicView),
      turns,
      events: [...this.events]
    };
  }

  ensureConversation(conversationId, workspacePath = "") {
    const existing = this.conversations.get(conversationId);
    if (existing) {
      if (workspacePath) {
        existing.workspacePath = String(workspacePath);
      }
      return existing;
    }
    const conversation = {
      conversationId,
      workspacePath: String(workspacePath || process.cwd()),
      threadId: "",
      activeTurnId: "",
      queuedTurnIds: [],
      status: "idle",
      updatedAt: nowIso()
    };
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  removeFromQueue(turnId) {
    this.globalQueue = this.globalQueue.filter((id) => id !== turnId);
  }

  reindexQueue() {
    const conversationPositions = new Map();
    this.globalQueue.forEach((turnId) => {
      const turn = this.turns.get(turnId);
      if (turn && turn.status === "queued") {
        const nextPosition = (conversationPositions.get(turn.conversationId) || 0) + 1;
        conversationPositions.set(turn.conversationId, nextPosition);
        turn.queuePosition = nextPosition;
      }
    });
  }

  pump() {
    let started = true;
    while (this.runningTurnIds.size < this.maxConcurrentSessions && this.globalQueue.length > 0 && started) {
      started = false;
      let startIndex = -1;
      let startTurn = null;
      let startConversation = null;

      for (let index = 0; index < this.globalQueue.length; index += 1) {
        const turnId = this.globalQueue[index];
        const turn = this.turns.get(turnId);
        if (!turn || turn.status !== "queued") {
          startIndex = index;
          break;
        }
        const conversation = this.conversations.get(turn.conversationId);
        if (!conversation) {
          startIndex = index;
          break;
        }
        if (conversation.activeTurnId) {
          continue;
        }
        startIndex = index;
        startTurn = turn;
        startConversation = conversation;
        break;
      }

      if (startIndex === -1) {
        break;
      }

      const [turnId] = this.globalQueue.splice(startIndex, 1);
      const turn = startTurn || this.turns.get(turnId);
      const conversation = startConversation || (turn ? this.conversations.get(turn.conversationId) : null);
      if (!turn || turn.status !== "queued") {
        started = true;
        continue;
      }
      if (!conversation) {
        started = true;
        continue;
      }
      conversation.queuedTurnIds = conversation.queuedTurnIds.filter((id) => id !== turnId);
      this.startQueuedTurn(turn, conversation);
      started = true;
    }
    this.reindexQueue();
  }

  startQueuedTurn(turn, conversation) {
    turn.status = "running";
    turn.startedAt = nowIso();
    turn.queuePosition = 0;
    conversation.activeTurnId = turn.turnId;
    conversation.status = "running";
    conversation.updatedAt = nowIso();
    this.runningTurnIds.add(turn.turnId);
    this.addEvent("turn-started", "Turn started", turn.prompt.slice(0, 120), turn);
    this.emit("turn-started", turnPublicView(turn));
    this.emitSnapshot();
    this.runTurn(turn, conversation).catch((error) => {
      if (turn.cancelled) {
        this.finishTurn(turn, conversation, { status: "cancelled" });
        return;
      }
      this.finishTurn(turn, conversation, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error || "Runtime turn failed.")
      });
    });
  }

  async runTurn(turn, conversation) {
    if (!conversation.threadId) {
      const startResult = await this.client.request("thread/start", {
        cwd: conversation.workspacePath
      });
      conversation.threadId = startResult.thread_id || startResult.thread?.id || "";
    }
    turn.threadId = conversation.threadId;

    if (this.runner) {
      const result = await this.runner(turn, conversation, (event) => this.ingestRuntimeEvent(event, turn));
      turn.output = result.output || turn.output;
      if (turn.cancelled || result.cancelled) {
        this.finishTurn(turn, conversation, { status: "cancelled" });
        return;
      }
      this.finishTurn(turn, conversation, { status: "completed" });
      return;
    }

    const result = await this.client.request("thread/message", {
      thread_id: conversation.threadId,
      input: turn.prompt,
      model: turn.model || undefined
    });
    const events = Array.isArray(result?.events) ? result.events : [];
    for (const event of events) {
      this.ingestRuntimeEvent(event, turn);
    }
    if (turn.cancelled) {
      this.finishTurn(turn, conversation, { status: "cancelled" });
      return;
    }
    this.finishTurn(turn, conversation, { status: "completed" });
  }

  ingestRuntimeEvent(event, turn) {
    if (!event || typeof event !== "object") return;
    if (event.event === "response_delta" && typeof event.delta === "string" && !isControlDelta(event.delta)) {
      turn.output += event.delta;
    }
    this.addEvent(event.event || event.type || "runtime-event", event.event || event.type || "Runtime event", isControlDelta(event.delta) ? "" : event.delta || event.message || "", turn);
    this.emit("runtime-event", { ...event, turnId: turn.turnId, conversationId: turn.conversationId });
  }

  finishTurn(turn, conversation, result) {
    if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") return;
    turn.cancelRunner = null;
    this.runningTurnIds.delete(turn.turnId);
    const finalStatus = result.status || "completed";
    turn.status = finalStatus;
    turn.error = result.error || "";
    turn.completedAt = nowIso();
    conversation.activeTurnId = conversation.activeTurnId === turn.turnId ? "" : conversation.activeTurnId;
    conversation.status = conversation.queuedTurnIds.length ? "queued" : "idle";
    conversation.updatedAt = nowIso();
    this.addEvent(`turn-${finalStatus}`, `Turn ${finalStatus}`, turn.error || turn.output.slice(-160), turn);
    this.emit(`turn-${finalStatus}`, turnPublicView(turn));
    this.emitSnapshot();
    this.pump();
  }

  addEvent(type, label, detail, turn = null) {
    const event = {
      id: createId("event"),
      type,
      label,
      detail: String(detail || ""),
      at: nowIso(),
      conversationId: turn?.conversationId || "",
      turnId: turn?.turnId || "",
      replyMessageId: turn?.replyMessageId || "",
      status: turn?.status || ""
    };
    this.events = [...this.events, event].slice(-this.maxEvents);
    this.emit("runtime:event", event);
    return event;
  }

  emitSnapshot() {
    this.emit("runtime:snapshot", this.snapshot());
  }
}

module.exports = {
  RuntimeOrchestrator,
  createDeepSeekCliRunner
};
