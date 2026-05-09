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
    url: String(server.url || "")
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
      pendingApprovals: this.pendingApprovals
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

  async listSkills(settings) {
    await this.ensureStarted(settings);
    const result = await this.requestJson("/v1/skills");
    return {
      ok: true,
      directory: String(result.directory || ""),
      warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
      skills: Array.isArray(result.skills) ? result.skills.map(normalizeSkill) : []
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
    const result = await this.requestJson("/v1/apps/mcp/servers");
    return {
      ok: true,
      servers: Array.isArray(result.servers) ? result.servers.map(normalizeMcpServer) : [],
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

  debugSnapshot() {
    return {
      ...this.snapshot(),
      token: this.token ? redactedEnvValue(this.token) : ""
    };
  }
}

module.exports = {
  RuntimeApiService,
  findFreePort
};
