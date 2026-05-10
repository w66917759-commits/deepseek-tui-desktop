const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const net = require("net");

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 15_000;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimError(error) {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}

function findFreePort(host = HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function redactedEnvValue(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "set";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function launchKeyFor(settings, runtimePath, workspacePath) {
  return JSON.stringify({
    runtimePath,
    workspacePath,
    binaryMode: settings.binaryMode,
    customBinaryPath: settings.customBinaryPath,
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    skillsDir: settings.skillsDir,
    skillsEnabled: settings.skillsEnabled,
    enabledSkills: settings.enabledSkills || [],
    mcpConfigPath: settings.mcpConfigPath,
    mcpEnabled: settings.mcpEnabled,
    enabledMcpServers: settings.enabledMcpServers || [],
    allowShell: settings.allowShell,
    maxSubagents: settings.maxSubagents,
    thinkingMode: settings.thinkingMode
  });
}

function normalizeSkill(raw) {
  const skill = raw && typeof raw === "object" ? raw : {};
  const name = String(skill.name || skill.id || skill.slug || "");
  return {
    ...skill,
    name,
    id: String(skill.id || name),
    enabled: skill.enabled !== false,
    description: String(skill.description || ""),
    path: String(skill.path || "")
  };
}

function normalizeMcpServer(raw) {
  const server = raw && typeof raw === "object" ? raw : {};
  const name = String(server.name || server.id || server.key || "");
  return {
    ...server,
    name,
    id: String(server.id || name),
    enabled: server.enabled !== false,
    status: String(server.status || ""),
    command: String(server.command || ""),
    url: String(server.url || ""),
    connected: Boolean(server.connected),
    error: String(server.error || "")
  };
}

function deepClone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function upsertRecordById(list, record) {
  if (!record || typeof record !== "object") return list.slice();
  const id = String(record.id || "");
  if (!id) return list.slice();
  const next = list.slice();
  const index = next.findIndex((candidate) => String(candidate?.id || "") === id);
  if (index >= 0) {
    next[index] = { ...next[index], ...deepClone(record) };
  } else {
    next.push(deepClone(record));
  }
  return next;
}

function ensureTurnItemLink(detail, turnId, itemId) {
  if (!turnId || !itemId) return detail;
  const turns = safeArray(detail.turns).map((turn) => {
    if (String(turn?.id || "") !== turnId) return turn;
    const itemIds = Array.isArray(turn.item_ids) ? turn.item_ids.slice() : [];
    if (!itemIds.includes(itemId)) itemIds.push(itemId);
    return { ...turn, item_ids: itemIds };
  });
  return { ...detail, turns };
}

function summarizeText(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function synthesizeApprovalItem(envelope) {
  const payload = envelope?.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const approvalId = String(payload.approval_id || payload.id || "");
  if (!approvalId || !envelope?.turn_id) return null;
  const description = String(payload.description || payload.message || "");
  return {
    id: `approval_${approvalId}`,
    turn_id: envelope.turn_id,
    kind: "approval_request",
    status: "in_progress",
    summary: summarizeText(description || payload.tool_name || approvalId),
    detail: description || String(payload.tool_name || approvalId),
    metadata: {
      approval_id: approvalId,
      tool_name: String(payload.tool_name || ""),
      action: String(payload.action || "approve_tool_call")
    },
    started_at: envelope.timestamp,
    ended_at: null
  };
}

function synthesizeUserInputItem(envelope) {
  const payload = envelope?.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const requestId = String(payload.request_id || payload.id || "");
  if (!requestId || !envelope?.turn_id) return null;
  const request = payload.request && typeof payload.request === "object" ? payload.request : {};
  const firstQuestion = Array.isArray(request.questions) ? request.questions[0] : null;
  const title = firstQuestion?.header || payload.title || "User input required";
  const detail = firstQuestion?.question || payload.message || title;
  return {
    id: envelope.item_id || `user_input_${requestId}`,
    turn_id: envelope.turn_id,
    kind: "user_input_request",
    status: envelope.event === "user_input.submitted" ? "completed" : "in_progress",
    summary: summarizeText(title),
    detail,
    metadata: {
      request_id: requestId,
      request,
      response: payload.response || payload.answer || null
    },
    started_at: envelope.timestamp,
    ended_at: envelope.event === "user_input.submitted" ? envelope.timestamp : null
  };
}

function patchStreamedItem(detail, envelope) {
  const payload = envelope?.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const itemId = String(envelope?.item_id || "");
  const turnId = String(envelope?.turn_id || "");
  if (!itemId || !turnId) return detail;
  const delta = String(payload.delta || payload.message || payload.detail || "");
  const existing = safeArray(detail.items).find((item) => String(item?.id || "") === itemId);
  const kind = String(payload.kind || existing?.kind || "status");
  const merged = {
    ...(existing || {}),
    id: itemId,
    turn_id: turnId,
    kind,
    status: "in_progress",
    summary: summarizeText(`${existing?.detail || ""}${delta}`),
    detail: `${existing?.detail || ""}${delta}`,
    metadata: {
      ...(existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
      ...payload
    },
    started_at: existing?.started_at || envelope.timestamp
  };
  let next = { ...detail, items: upsertRecordById(safeArray(detail.items), merged) };
  next = ensureTurnItemLink(next, turnId, itemId);
  return next;
}

function normalizeThreadDetail(raw, threadId = "") {
  const detail = raw && typeof raw === "object" ? deepClone(raw) : {};
  const thread = detail.thread && typeof detail.thread === "object"
    ? detail.thread
    : { id: threadId };
  return {
    thread,
    turns: safeArray(detail.turns),
    items: safeArray(detail.items),
    latest_seq: Number(detail.latest_seq || 0)
  };
}

function applyRuntimeThreadEventSnapshot(currentDetail, envelope) {
  const base = normalizeThreadDetail(currentDetail, envelope?.thread_id || "");
  const payload = envelope?.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  let next = {
    ...base,
    latest_seq: Math.max(Number(base.latest_seq || 0), Number(envelope?.seq || 0))
  };

  if (payload.thread && typeof payload.thread === "object") {
    next.thread = { ...next.thread, ...deepClone(payload.thread) };
  }
  if (payload.turn && typeof payload.turn === "object") {
    next.turns = upsertRecordById(next.turns, payload.turn);
  }
  if (payload.item && typeof payload.item === "object") {
    next.items = upsertRecordById(next.items, payload.item);
    next = ensureTurnItemLink(
      next,
      String(payload.item.turn_id || envelope?.turn_id || ""),
      String(payload.item.id || envelope?.item_id || "")
    );
  }

  if (envelope?.event === "item.delta") {
    next = patchStreamedItem(next, envelope);
  }

  if (envelope?.event === "approval.required") {
    const item = synthesizeApprovalItem(envelope);
    if (item) {
      next.items = upsertRecordById(next.items, item);
      next = ensureTurnItemLink(next, item.turn_id, item.id);
    }
  }

  if (envelope?.event === "approval.decided" || envelope?.event === "approval.timeout") {
    const approvalId = String(payload.approval_id || "");
    if (approvalId) {
      const itemId = `approval_${approvalId}`;
      const existing = safeArray(next.items).find((item) => String(item?.id || "") === itemId);
      if (existing) {
        next.items = upsertRecordById(next.items, {
          ...existing,
          status: envelope.event === "approval.decided" ? "completed" : "failed",
          metadata: {
            ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
            decision: String(payload.decision || ""),
            timeout_secs: Number(payload.timeout_secs || 0)
          },
          ended_at: envelope.timestamp
        });
      }
    }
  }

  if (envelope?.event === "user_input.required" || envelope?.event === "user_input.submitted") {
    const item = payload.item && typeof payload.item === "object"
      ? payload.item
      : synthesizeUserInputItem(envelope);
    if (item) {
      next.items = upsertRecordById(next.items, item);
      next = ensureTurnItemLink(next, String(item.turn_id || envelope?.turn_id || ""), String(item.id || ""));
    }
  }

  return next;
}

function deriveRuntimeCapabilityState(input = {}) {
  const selected = Boolean(input.selected);
  const enabled = Boolean(input.enabled);
  const injected = Boolean(input.injected);
  const loaded = Boolean(input.loaded);
  const callable = Boolean(input.callable);
  const approvalBlocked = Boolean(input.approvalBlocked);
  const reason = String(input.failureReason || input.reason || "");
  const failed = Boolean(reason);
  let state = "disabled";
  if (failed) {
    state = "failed";
  } else if (approvalBlocked) {
    state = "approval_blocked";
  } else if (callable) {
    state = "callable";
  } else if (loaded) {
    state = "loaded";
  } else if (injected) {
    state = "injected";
  } else if (enabled) {
    state = "enabled";
  } else if (selected) {
    state = "selected";
  }
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

class RuntimeApiService extends EventEmitter {
  constructor({ app, harness }) {
    super();
    this.app = app;
    this.harness = harness;
    this.child = null;
    this.port = 0;
    this.token = "";
    this.launchKey = "";
    this.startPromise = null;
    this.state = "idle";
    this.error = "";
    this.startedAt = "";
    this.updatedAt = nowIso();
    this.info = null;
    this.health = null;
    this.lastStdout = "";
    this.lastStderr = "";
    this.pendingApprovals = [];
    this.pendingUserInputs = [];
    this.threadDetails = new Map();
    this.threadSubscriptions = new Map();
    this.stopping = false;
  }

  snapshot() {
    return {
      state: this.state,
      connected: this.state === "connected",
      host: HOST,
      port: this.port,
      url: this.port ? `http://${HOST}:${this.port}` : "",
      pid: this.child?.pid || 0,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      error: this.error,
      info: this.info,
      health: this.health,
      lastStdout: this.lastStdout,
      lastStderr: this.lastStderr,
      pendingApprovals: this.pendingApprovals,
      pendingUserInputs: this.pendingUserInputs
    };
  }

  emitStatus() {
    this.updatedAt = nowIso();
    this.emit("status", this.snapshot());
  }

  readSettings(settings) {
    const saved = this.harness.readSettings();
    return settings && typeof settings === "object" ? { ...saved, ...settings } : saved;
  }

  async ensureStarted(settingsPayload) {
    const settings = this.readSettings(settingsPayload);
    const workspacePath = settings.workspacePath || this.app.getPath("userData");
    const runtime = this.harness.resolveRuntime(settings);
    const nextLaunchKey = launchKeyFor(settings, runtime.selected, workspacePath);

    if (this.child && this.state === "connected" && this.launchKey === nextLaunchKey) {
      return this.snapshot();
    }
    if (this.startPromise) {
      await this.startPromise;
      if (this.child && this.state === "connected" && this.launchKey === nextLaunchKey) {
        return this.snapshot();
      }
    }
    if (this.child && (this.launchKey !== nextLaunchKey || this.state !== "connected")) {
      await this.stop();
    }

    this.startPromise = this.start(settings, runtime, workspacePath, nextLaunchKey)
      .finally(() => {
        this.startPromise = null;
      });
    await this.startPromise;
    return this.snapshot();
  }

  async start(settings, runtime, workspacePath, nextLaunchKey) {
    if (!runtime.selectedExists) {
      this.state = "error";
      this.error = "Bundled or selected DeepSeek runtime was not found.";
      this.emitStatus();
      return this.snapshot();
    }

    this.stopping = false;
    this.state = "starting";
    this.error = "";
    this.health = null;
    this.info = null;
    this.lastStdout = "";
    this.lastStderr = "";
    this.pendingApprovals = [];
    this.port = await findFreePort(HOST);
    this.token = crypto.randomBytes(24).toString("base64url");
    this.launchKey = nextLaunchKey;
    this.startedAt = nowIso();
    this.emitStatus();

    const env = {
      ...this.harness.buildEnv(settings, workspacePath),
      DEEPSEEK_RUNTIME_TOKEN: this.token
    };
    const args = [
      "serve",
      "--http",
      "--host",
      HOST,
      "--port",
      String(this.port),
      "--auth-token",
      this.token
    ];

    this.child = spawn(runtime.selected, args, {
      cwd: workspacePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout.on("data", (chunk) => {
      this.lastStdout = String(chunk || "").trim().slice(-2000);
      this.emitStatus();
    });
    this.child.stderr.on("data", (chunk) => {
      this.lastStderr = String(chunk || "").trim().slice(-2000);
      this.emitStatus();
    });
    this.child.on("error", (error) => {
      this.state = "error";
      this.error = trimError(error);
      this.emitStatus();
    });
    this.child.on("exit", (code, signal) => {
      if (this.stopping) {
        this.state = "stopped";
        this.error = "";
      } else {
        this.state = "error";
        this.error = `Runtime API exited: code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`;
      }
      this.child = null;
      this.emitStatus();
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        this.health = await this.requestJson("/health", { auth: false, timeoutMs: 1000 });
        if (this.health?.status === "ok") {
          this.info = await this.requestJson("/v1/runtime/info");
          this.state = "connected";
          this.error = "";
          this.emitStatus();
          return this.snapshot();
        }
      } catch (error) {
        lastError = trimError(error);
      }
      if (!this.child) break;
      await sleep(250);
    }

    this.state = "error";
    this.error = lastError || "Runtime API did not become healthy before the startup timeout.";
    this.emitStatus();
    if (this.child) {
      await this.stop();
      this.state = "error";
      this.error = lastError || "Runtime API did not become healthy before the startup timeout.";
      this.emitStatus();
    }
    return this.snapshot();
  }

  async stop() {
    this.closeAllThreadSubscriptions();
    if (!this.child) {
      this.state = this.state === "idle" ? "idle" : "stopped";
      this.emitStatus();
      return this.snapshot();
    }
    this.stopping = true;
    const child = this.child;
    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        clearTimeout(finalTimer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          finish();
        }
      }, 2000);
      const finalTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 5000);
      const forceTimer = timer;
      child.once("exit", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      // Ignore cleanup errors from already-closed pipes.
    }
    this.child = null;
    this.state = "stopped";
    this.error = "";
    this.emitStatus();
    return this.snapshot();
  }

  closeAllThreadSubscriptions() {
    for (const entry of this.threadSubscriptions.values()) {
      entry.closed = true;
      try {
        entry.request?.destroy();
      } catch {
        // Ignore stream teardown errors during shutdown or relaunch.
      }
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
      }
    }
    this.threadSubscriptions.clear();
  }

  parseSseFrame(frame) {
    const lines = String(frame || "").split(/\r?\n/);
    let eventName = "";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (!eventName) return null;
    let data = {};
    if (dataLines.length > 0) {
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        data = { raw: dataLines.join("\n") };
      }
    }
    return { event: eventName, data };
  }

  upsertPendingApproval(record) {
    const approvalId = String(record.approvalId || record.id || "");
    if (!approvalId) return;
    const next = this.pendingApprovals.filter((candidate) => {
      const candidateId = String(candidate.approvalId || candidate.id || "");
      return candidateId !== approvalId;
    });
    next.push(record);
    this.pendingApprovals = next;
  }

  removePendingApproval(approvalId) {
    const id = String(approvalId || "");
    if (!id) return;
    this.pendingApprovals = this.pendingApprovals.filter((candidate) => {
      const candidateId = String(candidate.approvalId || candidate.id || "");
      return candidateId !== id;
    });
  }

  upsertPendingUserInput(record) {
    const requestId = String(record.requestId || record.id || "");
    if (!requestId) return;
    const next = this.pendingUserInputs.filter((candidate) => {
      const candidateId = String(candidate.requestId || candidate.id || "");
      return candidateId !== requestId;
    });
    next.push(record);
    this.pendingUserInputs = next;
  }

  removePendingUserInput(requestId) {
    const id = String(requestId || "");
    if (!id) return;
    this.pendingUserInputs = this.pendingUserInputs.filter((candidate) => {
      const candidateId = String(candidate.requestId || candidate.id || "");
      return candidateId !== id;
    });
  }

  handleThreadEventEnvelope(threadId, envelope) {
    const cached = this.threadDetails.get(threadId) || normalizeThreadDetail({ thread: { id: threadId } }, threadId);
    const nextDetail = applyRuntimeThreadEventSnapshot(cached, envelope);
    this.threadDetails.set(threadId, nextDetail);

    const payload = envelope?.payload && typeof envelope.payload === "object" ? envelope.payload : {};
    if (envelope.event === "approval.required") {
      this.upsertPendingApproval({
        id: String(payload.id || payload.approval_id || ""),
        approvalId: String(payload.approval_id || payload.id || ""),
        threadId,
        turnId: String(envelope.turn_id || ""),
        toolName: String(payload.tool_name || ""),
        title: String(payload.tool_name || "Approval required"),
        message: String(payload.description || "")
      });
    }
    if (envelope.event === "approval.decided" || envelope.event === "approval.timeout") {
      this.removePendingApproval(payload.approval_id || payload.id);
    }
    if (envelope.event === "user_input.required") {
      this.upsertPendingUserInput({
        id: String(payload.request_id || payload.id || ""),
        requestId: String(payload.request_id || payload.id || ""),
        threadId,
        turnId: String(envelope.turn_id || ""),
        title: String(payload.title || ""),
        message: String(payload.message || ""),
        questions: Array.isArray(payload.request?.questions) ? payload.request.questions : []
      });
    }
    if (envelope.event === "user_input.submitted" || envelope.event === "user_input.cancelled") {
      this.removePendingUserInput(payload.request_id || payload.id);
    }

    this.emitStatus();
    this.emit("thread-event", {
      threadId,
      detail: deepClone(nextDetail),
      event: deepClone(envelope)
    });
    return nextDetail;
  }

  subscribeThread(threadId, settings) {
    const id = String(threadId || "").trim();
    if (!id) return;
    const existing = this.threadSubscriptions.get(id);
    if (existing && !existing.closed) {
      return;
    }

    const entry = {
      closed: false,
      request: null,
      retryTimer: null
    };
    this.threadSubscriptions.set(id, entry);

    const connect = () => {
      if (entry.closed || !this.port || !this.token) return;
      const cached = this.threadDetails.get(id);
      const sinceSeq = Number(cached?.latest_seq || 0);
      const path = `/v1/threads/${encodeURIComponent(id)}/events?since_seq=${sinceSeq}`;
      const request = http.request({
        hostname: HOST,
        port: this.port,
        path,
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.token}`
        }
      }, (response) => {
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffer += String(chunk || "");
          let boundary = buffer.search(/\r?\n\r?\n/);
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + (buffer.startsWith("\r\n\r\n", boundary) ? 4 : 2));
            const parsed = this.parseSseFrame(frame);
            if (parsed && parsed.event !== "keepalive") {
              this.handleThreadEventEnvelope(id, parsed.data);
            }
            boundary = buffer.search(/\r?\n\r?\n/);
          }
        });
        response.on("end", () => {
          if (entry.closed) return;
          entry.retryTimer = setTimeout(connect, 500);
        });
      });
      entry.request = request;
      request.on("error", (error) => {
        this.lastStderr = trimError(error).slice(-2000);
        this.emitStatus();
        if (entry.closed) return;
        entry.retryTimer = setTimeout(connect, 750);
      });
      request.end();
    };

    void this.ensureStarted(settings).then(connect).catch((error) => {
      this.lastStderr = trimError(error).slice(-2000);
      this.emitStatus();
    });
  }

  requestJson(pathname, options = {}) {
    const method = options.method || "GET";
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const timeoutMs = options.timeoutMs || 10_000;
    const auth = options.auth !== false;

    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: HOST,
        port: this.port,
        path: pathname,
        method,
        timeout: timeoutMs,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
          ...(auth ? { Authorization: `Bearer ${this.token}` } : {})
        }
      }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          if (text.trim()) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { raw: text };
            }
          }
          if (response.statusCode && response.statusCode >= 400) {
            const message = parsed?.error?.message || parsed?.message || text || `HTTP ${response.statusCode}`;
            const error = new Error(message);
            error.statusCode = response.statusCode;
            reject(error);
            return;
          }
          resolve(parsed || {});
        });
      });
      request.on("timeout", () => {
        request.destroy(new Error(`Runtime API request timed out: ${method} ${pathname}`));
      });
      request.on("error", reject);
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }

  async getStatus(settings) {
    await this.ensureStarted(settings);
    return this.snapshot();
  }

  async getInfo(settings) {
    await this.ensureStarted(settings);
    this.info = await this.requestJson("/v1/runtime/info");
    this.emitStatus();
    return { ok: true, info: this.info };
  }

  threadRequestBody(settings = {}, overrides = {}) {
    const merged = this.readSettings(settings);
    return {
      model: overrides.model || merged.model || "deepseek-v4-pro",
      workspace: overrides.workspacePath || merged.workspacePath,
      mode: overrides.mode || "agent",
      allow_shell: Boolean(overrides.allowShell ?? merged.allowShell),
      trust_mode: Boolean(overrides.trustMode),
      auto_approve: Boolean(overrides.autoApprove),
      archived: Boolean(overrides.archived)
    };
  }

  async listThreads(settings) {
    await this.ensureStarted(settings);
    const threads = await this.requestJson("/v1/threads/summary?include_archived=true");
    return {
      ok: true,
      threads: Array.isArray(threads) ? threads : []
    };
  }

  async createThread(payload = {}) {
    await this.ensureStarted(payload.settings);
    const body = this.threadRequestBody(payload.settings, payload);
    const thread = await this.requestJson("/v1/threads", {
      method: "POST",
      body
    });
    if (thread?.id) {
      this.threadDetails.set(thread.id, normalizeThreadDetail({ thread, turns: [], items: [], latest_seq: 0 }, thread.id));
      this.subscribeThread(thread.id, payload.settings);
    }
    return { ok: true, thread };
  }

  async getThreadDetail(payload = {}) {
    const threadId = String(payload.threadId || payload.id || "").trim();
    if (!threadId) {
      return { ok: false, error: "Missing thread id" };
    }
    await this.ensureStarted(payload.settings);
    const detail = normalizeThreadDetail(
      await this.requestJson(`/v1/threads/${encodeURIComponent(threadId)}`),
      threadId
    );
    this.threadDetails.set(threadId, detail);
    this.subscribeThread(threadId, payload.settings);
    return { ok: true, detail };
  }

  async resumeThread(payload = {}) {
    const threadId = String(payload.threadId || payload.id || "").trim();
    if (!threadId) {
      return { ok: false, error: "Missing thread id" };
    }
    await this.ensureStarted(payload.settings);
    const thread = await this.requestJson(`/v1/threads/${encodeURIComponent(threadId)}/resume`, {
      method: "POST",
      body: {}
    });
    this.subscribeThread(threadId, payload.settings);
    return { ok: true, thread };
  }

  async forkThread(payload = {}) {
    const threadId = String(payload.threadId || payload.id || "").trim();
    if (!threadId) {
      return { ok: false, error: "Missing thread id" };
    }
    await this.ensureStarted(payload.settings);
    const thread = await this.requestJson(`/v1/threads/${encodeURIComponent(threadId)}/fork`, {
      method: "POST",
      body: {}
    });
    if (thread?.id) {
      this.subscribeThread(thread.id, payload.settings);
    }
    return { ok: true, thread };
  }

  async archiveThread(payload = {}) {
    const threadId = String(payload.threadId || payload.id || "").trim();
    if (!threadId) {
      return { ok: false, error: "Missing thread id" };
    }
    await this.ensureStarted(payload.settings);
    const thread = await this.requestJson(`/v1/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: { archived: payload.archived !== false }
    });
    return { ok: true, thread };
  }

  async ensureConversationThread(payload = {}) {
    const existingThreadId = String(payload.threadId || payload.runtimeThreadId || "").trim();
    if (existingThreadId) {
      await this.resumeThread({ threadId: existingThreadId, settings: payload.settings });
      return existingThreadId;
    }
    const created = await this.createThread(payload);
    if (!created.ok || !created.thread?.id) {
      throw new Error(created.error || "Failed to create runtime thread");
    }
    return created.thread.id;
  }

  async startThreadTurn(payload = {}) {
    await this.ensureStarted(payload.settings);
    const threadId = await this.ensureConversationThread(payload);
    const merged = this.readSettings(payload.settings);
    const turnResult = await this.requestJson(`/v1/threads/${encodeURIComponent(threadId)}/turns`, {
      method: "POST",
      body: {
        prompt: String(payload.prompt || ""),
        model: payload.model || merged.model || undefined,
        mode: payload.mode || "agent",
        allow_shell: Boolean(payload.allowShell ?? merged.allowShell),
        trust_mode: Boolean(payload.trustMode),
        auto_approve: Boolean(payload.autoApprove)
      }
    });
    const detail = normalizeThreadDetail(
      await this.requestJson(`/v1/threads/${encodeURIComponent(threadId)}`),
      threadId
    );
    this.threadDetails.set(threadId, detail);
    this.subscribeThread(threadId, payload.settings);
    return {
      ok: true,
      threadId,
      thread: turnResult.thread || detail.thread,
      turn: turnResult.turn,
      detail
    };
  }

  async steerTurn(payload = {}) {
    const threadId = String(payload.threadId || "").trim();
    const turnId = String(payload.turnId || "").trim();
    if (!threadId || !turnId) {
      return { ok: false, error: "Missing thread id or turn id" };
    }
    await this.ensureStarted(payload.settings);
    const turn = await this.requestJson(
      `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/steer`,
      {
        method: "POST",
        body: { prompt: String(payload.prompt || "") }
      }
    );
    return { ok: true, turn };
  }

  async interruptTurn(payload = {}) {
    const threadId = String(payload.threadId || "").trim();
    const turnId = String(payload.turnId || "").trim();
    if (!threadId || !turnId) {
      return { ok: false, error: "Missing thread id or turn id" };
    }
    await this.ensureStarted(payload.settings);
    const turn = await this.requestJson(
      `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
      {
        method: "POST",
        body: {}
      }
    );
    return { ok: true, turn };
  }

  async answerUserInput(payload = {}) {
    const threadId = String(payload.threadId || "").trim();
    const turnId = String(payload.turnId || "").trim();
    const requestId = String(payload.requestId || payload.id || "").trim();
    if (!threadId || !turnId || !requestId) {
      return { ok: false, error: "Missing thread id, turn id, or request id" };
    }
    await this.ensureStarted(payload.settings);
    const result = await this.requestJson(
      `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/requests/${encodeURIComponent(requestId)}/answer`,
      {
        method: "POST",
        body: {
          answers: Array.isArray(payload.answers) ? payload.answers : []
        }
      }
    );
    this.removePendingUserInput(requestId);
    this.emitStatus();
    return { ok: true, result };
  }

  async listSkills(settings) {
    await this.ensureStarted(settings);
    const merged = this.readSettings(settings);
    const result = await this.requestJson("/v1/skills");
    return {
      ok: true,
      directory: String(result.directory || ""),
      warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
      skills: Array.isArray(result.skills)
        ? result.skills.map((raw) => {
          const skill = normalizeSkill(raw);
          const selected = Array.isArray(merged.enabledSkills) && merged.enabledSkills.includes(skill.id || skill.name);
          return {
            ...skill,
            runtimeState: deriveRuntimeCapabilityState({
              selected,
              enabled: skill.enabled,
              injected: Boolean(merged.skillsEnabled && selected),
              loaded: skill.enabled,
              callable: Boolean(merged.skillsEnabled && selected && skill.enabled)
            })
          };
        })
        : []
    };
  }

  async setSkillEnabled(payload = {}) {
    const name = String(payload.name || payload.id || "").trim();
    if (!name) {
      return { ok: false, error: "Missing skill name" };
    }
    await this.ensureStarted(payload.settings);
    const result = await this.requestJson(`/v1/skills/${encodeURIComponent(name)}`, {
      method: "POST",
      body: { enabled: Boolean(payload.enabled) }
    });
    return {
      ok: true,
      skill: normalizeSkill(result.skill || result),
      result
    };
  }

  async listMcpServers(settings) {
    await this.ensureStarted(settings);
    const merged = this.readSettings(settings);
    const result = await this.requestJson("/v1/apps/mcp/servers");
    return {
      ok: true,
      servers: Array.isArray(result.servers)
        ? result.servers.map((raw) => {
          const server = normalizeMcpServer(raw);
          const selected = Array.isArray(merged.enabledMcpServers) && merged.enabledMcpServers.includes(server.id || server.name);
          const injected = Boolean(merged.mcpEnabled && selected);
          const connected = Boolean(server.connected);
          const failureReason = injected && !connected
            ? server.error || server.status || (!server.command && !server.url ? "Not configured" : "Not connected")
            : "";
          return {
            ...server,
            runtimeState: deriveRuntimeCapabilityState({
              selected,
              enabled: server.enabled,
              injected,
              loaded: server.enabled,
              callable: connected,
              failureReason
            })
          };
        })
        : [],
      result
    };
  }

  async decideApproval(payload = {}) {
    const approvalId = String(payload.approvalId || payload.id || "").trim();
    if (!approvalId) {
      return { ok: false, error: "Missing approval id" };
    }
    await this.ensureStarted(payload.settings);
    const decision = payload.decision === "deny" ? "deny" : "allow";
    const result = await this.requestJson(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: {
        decision,
        remember: Boolean(payload.remember)
      }
    });
    this.pendingApprovals = this.pendingApprovals.filter((approval) => approval.id !== approvalId && approval.approvalId !== approvalId);
    this.emitStatus();
    return { ok: true, result };
  }

  async startRuntimeTurn(payload = {}) {
    try {
      const result = await this.startThreadTurn(payload);
      return {
        ok: true,
        queued: false,
        turnId: result.turn?.id || "",
        conversationId: String(payload.conversationId || ""),
        threadId: result.threadId,
        detail: result.detail
      };
    } catch (error) {
      return { ok: false, error: trimError(error) };
    }
  }

  debugSnapshot() {
    return {
      ...this.snapshot(),
      token: this.token ? redactedEnvValue(this.token) : ""
    };
  }
}

module.exports = {
  RuntimeApiService,
  applyRuntimeThreadEventSnapshot,
  deriveRuntimeCapabilityState,
  findFreePort
};
