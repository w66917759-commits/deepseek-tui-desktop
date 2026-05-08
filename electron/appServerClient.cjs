const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function createError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || "";
    this.args = Array.isArray(options.args) ? options.args.map(String) : [];
    this.cwd = options.cwd || process.cwd();
    this.env = { ...process.env, ...(options.env || {}) };
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
    this.child = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closing = false;
  }

  get running() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  get pid() {
    return this.child?.pid || 0;
  }

  start() {
    if (this.running) {
      return;
    }
    if (!this.command) {
      throw createError("App server command is not configured.");
    }

    this.closing = false;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });

    this.rl.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (data) => {
      this.emit("stderr", String(data || ""));
    });
    child.on("error", (error) => {
      this.rejectAll(createError(`App server failed to start: ${error.message}`, { cause: error }));
      this.emit("error", error);
    });
    child.on("exit", (code, signal) => {
      const error = createError(`App server exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}.`, {
        code,
        signal
      });
      this.rejectAll(error);
      this.emit("exit", { code, signal });
      if (this.child === child) {
        this.child = null;
      }
      if (this.rl) {
        this.rl.close();
        this.rl = null;
      }
    });
  }

  request(method, params = {}, options = {}) {
    this.start();
    const child = this.child;
    if (!child?.stdin?.writable) {
      return Promise.reject(createError("App server stdin is not writable."));
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = Number(options.timeoutMs) || this.requestTimeoutMs;
    const frame = {
      jsonrpc: "2.0",
      id,
      method,
      params: params && typeof params === "object" ? params : {}
    };

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(createError(`App server request timed out: ${method}`, { method, id }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
    });

    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      }
    }

    return promise;
  }

  handleLine(line) {
    const text = String(line || "").trim();
    if (!text) return;

    let frame;
    try {
      frame = JSON.parse(text);
    } catch (error) {
      this.emit("stderr", `${text}\n`);
      return;
    }

    if (Object.hasOwn(frame, "id") && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))) {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        this.emit("unmatched-response", frame);
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(frame.id);
      if (frame.error) {
        pending.reject(createError(frame.error.message || `App server request failed: ${pending.method}`, {
          rpcError: frame.error,
          method: pending.method,
          id: frame.id
        }));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    this.emit("event", frame);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async close() {
    this.closing = true;
    const child = this.child;
    this.rejectAll(createError("App server client closed."));
    if (!child) {
      return;
    }
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.kill();
      setTimeout(done, 250).unref?.();
    });
  }
}

module.exports = {
  AppServerClient
};
