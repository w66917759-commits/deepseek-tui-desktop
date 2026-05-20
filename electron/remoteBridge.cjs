const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Notification } = require("electron");

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TERMINAL_CHARS = 80_000;
const MAX_PAIRING_ATTEMPTS = 20;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const VALID_ACTIONS = new Set(["tui", "continue", "doctor", "setup", "mcp-init", "sessions", "exec", "plan"]);
const DEFAULT_RELAY_URL = "https://deepseektuidesktop.cn";

function now() {
  return new Date().toISOString();
}

function trimString(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function createAuthToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function createPairingCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function normalizeAccountId(value) {
  return trimString(value, 160).trim().toLowerCase();
}

function normalizeRelayUrl(value) {
  const trimmed = String(value || DEFAULT_RELAY_URL).trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_RELAY_URL;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function relayWebSocketUrl(relayUrl, desktopId, secret) {
  const endpoint = new URL("/desktop/connect", normalizeRelayUrl(relayUrl));
  endpoint.protocol = endpoint.protocol === "http:" ? "ws:" : "wss:";
  endpoint.searchParams.set("desktopId", desktopId);
  endpoint.searchParams.set("secret", secret);
  return endpoint.toString();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-deepseek-bridge-token, x-deepseek-device-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function primaryLanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "";
}

function normalizeAction(action) {
  return VALID_ACTIONS.has(action) ? action : "tui";
}

function defaultAuthState() {
  return {
    desktopId: randomId("desktop"),
    activePairing: null,
    account: null,
    pairing: null,
    devices: [],
    relaySecret: createAuthToken(),
    lastRelayState: null
  };
}

class DesktopRemoteBridge {
  constructor(electronApp, harness) {
    this.app = electronApp;
    this.harness = harness;
    this.server = null;
    this.settings = null;
    this.error = "";
    this.clients = new Set();
    this.terminalBuffer = "";
    this.lastTerminalAt = "";
    this.lastUpdateNotice = null;
    this.authState = this.readAuthState();
    this.pairingAttempts = new Map();
    this.relay = {
      ws: null,
      reconnectTimer: null,
      url: "",
      connected: false,
      sessionId: "",
      lastConnectedAt: "",
      lastError: "",
      reconnectAttempts: 0,
      shouldReconnect: false
    };
  }

  authFilePath() {
    return path.join(this.app.getPath("userData"), "remote-auth.json");
  }

  readAuthState() {
    try {
      const raw = fs.readFileSync(this.authFilePath(), "utf8");
      const parsed = JSON.parse(raw);
      const defaults = defaultAuthState();
      return {
        ...defaults,
        ...parsed,
        activePairing: parsed.activePairing || parsed.pairing || null,
        pairing: parsed.activePairing || parsed.pairing || null,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        relaySecret: parsed.relaySecret || defaults.relaySecret
      };
    } catch {
      const state = defaultAuthState();
      this.writeAuthState(state);
      return state;
    }
  }

  writeAuthState(state = this.authState) {
    state.pairing = state.activePairing || null;
    this.authState = state;
    fs.mkdirSync(this.app.getPath("userData"), { recursive: true });
    fs.writeFileSync(this.authFilePath(), JSON.stringify(state, null, 2));
    return this.authState;
  }

  getActivePairing() {
    const pairing = this.authState.activePairing || this.authState.pairing;
    if (!pairing) return null;
    if (Date.parse(pairing.expiresAt) <= Date.now()) {
      this.authState.activePairing = null;
      this.authState.pairing = null;
      this.writeAuthState();
      return null;
    }
    return pairing;
  }

  configure(settings) {
    this.settings = { ...settings };
    this.error = "";

    if (!this.settings.mobileBridgeEnabled) {
      this.stop();
      this.disconnectRelay();
      return this.getStatus(true);
    }

    const currentAddress = this.server ? this.server.address() : null;
    const currentPort = currentAddress && typeof currentAddress === "object" ? currentAddress.port : null;
    const currentHost = currentAddress && typeof currentAddress === "object" ? currentAddress.address : null;
    const needsRestart = !this.server
      || currentPort !== this.settings.mobileBridgePort
      || !this.hostMatches(currentHost, this.settings.mobileBridgeHost);

    if (needsRestart) {
      this.stop();
      this.startServer();
    }

    this.connectRelay();
    this.broadcast("bridge-status", this.getStatus(false));
    return this.getStatus(true);
  }

  hostMatches(actualHost, desiredHost) {
    if (!actualHost) return false;
    if (desiredHost === "0.0.0.0") {
      return actualHost === "0.0.0.0" || actualHost === "::";
    }
    return actualHost === desiredHost;
  }

  ensureRelaySecret() {
    if (!this.authState.relaySecret) {
      this.authState.relaySecret = createAuthToken();
      this.writeAuthState();
    }
    return this.authState.relaySecret;
  }

  connectRelay() {
    const relayUrl = normalizeRelayUrl(this.settings?.mobileRelayUrl || DEFAULT_RELAY_URL);
    this.relay.url = relayUrl;
    this.relay.shouldReconnect = true;

    if (typeof WebSocket !== "function") {
      this.relay.connected = false;
      this.relay.lastError = "This Electron runtime does not provide WebSocket in the main process";
      return;
    }

    if (this.relay.ws && (this.relay.ws.readyState === WebSocket.OPEN || this.relay.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clearTimeout(this.relay.reconnectTimer);
    const desktopId = this.authState.desktopId;
    const secret = this.ensureRelaySecret();
    let ws;
    try {
      ws = new WebSocket(relayWebSocketUrl(relayUrl, desktopId, secret));
    } catch (error) {
      this.relay.connected = false;
      this.relay.lastError = error.message || "Relay connection failed";
      this.scheduleRelayReconnect();
      return;
    }

    this.relay.ws = ws;
    ws.onopen = () => {
      this.relay.connected = true;
      this.relay.lastConnectedAt = now();
      this.relay.lastError = "";
      this.relay.reconnectAttempts = 0;
      this.sendRelayMessage({
        type: "desktop.hello",
        desktopId,
        secret,
        status: this.getStatus(false)
      });
      const pairing = this.getActivePairing();
      if (pairing) this.publishPairingToRelay(pairing);
      this.broadcast("bridge-status", this.getStatus(false));
    };
    ws.onmessage = (event) => {
      this.handleRelayMessage(event.data).catch((error) => {
        this.relay.lastError = error.message || "Relay message failed";
      });
    };
    ws.onerror = () => {
      this.relay.lastError = "Relay socket error";
      this.broadcast("bridge-status", this.getStatus(false));
    };
    ws.onclose = () => {
      this.relay.connected = false;
      this.relay.ws = null;
      this.broadcast("bridge-status", this.getStatus(false));
      if (this.relay.shouldReconnect && this.settings?.mobileBridgeEnabled) this.scheduleRelayReconnect();
    };
  }

  disconnectRelay() {
    this.relay.shouldReconnect = false;
    clearTimeout(this.relay.reconnectTimer);
    this.relay.reconnectTimer = null;
    this.relay.connected = false;
    if (this.relay.ws) {
      try {
        this.relay.ws.close();
      } catch {
        // Ignore close failures from partially-open sockets.
      }
      this.relay.ws = null;
    }
  }

  scheduleRelayReconnect() {
    clearTimeout(this.relay.reconnectTimer);
    this.relay.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * this.relay.reconnectAttempts);
    this.relay.reconnectTimer = setTimeout(() => this.connectRelay(), delay);
  }

  sendRelayMessage(message) {
    const openState = typeof WebSocket === "function" ? WebSocket.OPEN : 1;
    if (!this.relay.ws || this.relay.ws.readyState !== openState) return false;
    this.relay.ws.send(JSON.stringify(message));
    return true;
  }

  publishPairingToRelay(pairing) {
    return this.sendRelayMessage({
      type: "pairing.start",
      desktopId: this.authState.desktopId,
      relaySessionId: pairing.relaySessionId,
      codeHash: pairing.codeHash,
      codePreview: pairing.codePreview,
      expiresAt: pairing.expiresAt,
      createdAt: pairing.createdAt
    });
  }

  async handleRelayMessage(raw) {
    const message = JSON.parse(String(raw || "{}"));
    if (message.type === "relay.ready") {
      this.relay.sessionId = trimString(message.relaySessionId || "", 160);
      this.broadcast("bridge-status", this.getStatus(false));
      return;
    }
    if (message.type === "device.paired") {
      this.upsertRelayDevice(message.device || {}, message.tokenHash || message.deviceTokenHash || "");
      this.authState.activePairing = null;
      this.authState.pairing = null;
      this.writeAuthState();
      this.broadcast("auth-state", this.getAuthPublicState());
      this.broadcast("bridge-status", this.getStatus(false));
      return;
    }
    if (message.type === "command") {
      const payload = await this.handleRelayCommand(message);
      this.sendRelayMessage({
        type: "command.result",
        requestId: message.requestId,
        payload
      });
    }
  }

  upsertRelayDevice(payload, tokenHash) {
    if (!tokenHash) return null;
    const device = {
      id: trimString(payload.id || randomId("device"), 120),
      accountId: trimString(payload.accountId || "relay", 160),
      desktopId: trimString(payload.desktopId || this.authState.desktopId, 160),
      relaySessionId: trimString(payload.relaySessionId || this.relay.sessionId, 160),
      name: trimString(payload.name || payload.deviceName || "Mobile device", 120),
      platform: trimString(payload.platform || "web", 40),
      clientDeviceId: trimString(payload.clientDeviceId || "", 160),
      pushProvider: trimString(payload.pushProvider || "", 40),
      pushToken: trimString(payload.pushToken || "", 500),
      tokenHash,
      pairedAt: trimString(payload.pairedAt || now(), 80),
      lastSeenAt: trimString(payload.lastSeenAt || now(), 80),
      enabled: payload.enabled !== false
    };

    this.authState.devices = this.authState.devices.filter((candidate) => (
      candidate.id !== device.id
      && (!device.clientDeviceId || candidate.clientDeviceId !== device.clientDeviceId)
    ));
    this.authState.devices.push(device);
    return device;
  }

  async handleRelayCommand(message) {
    const deviceId = trimString(message.device?.id || "", 120);
    const device = this.authState.devices.find((candidate) => candidate.enabled !== false && candidate.id === deviceId);
    if (!device) {
      return { ok: false, error: "Unauthorized", status: 401 };
    }
    this.markDeviceSeen(device);

    if (message.command === "status") {
      return { ok: true, status: this.getStatus(false), auth: this.publicDevice(device) };
    }

    if (!this.settings?.mobileRemoteControlEnabled) {
      return { ok: false, error: "Remote control is disabled on this desktop", status: 403 };
    }

    if (message.command === "session.start") {
      const body = message.payload && typeof message.payload === "object" ? message.payload : {};
      const settings = this.harness.readSettings();
      const options = {
        ...settings,
        ...(body.options && typeof body.options === "object" ? body.options : {}),
        launchAction: normalizeAction(body.action),
        agentPrompt: trimString(body.prompt, 12000)
      };
      const result = this.harness.start(options);
      this.broadcast("bridge-status", this.getStatus(false));
      return { ok: Boolean(result.ok), result, status: this.getStatus(false) };
    }

    if (message.command === "session.stop") {
      const result = this.harness.stop();
      this.broadcast("bridge-status", this.getStatus(false));
      return { ok: true, result, status: this.getStatus(false) };
    }

    if (message.command === "terminal.input") {
      const data = typeof message.payload?.data === "string" ? message.payload.data : "";
      if (!data) return { ok: false, error: "Missing terminal input data", status: 400 };
      this.harness.input(data);
      return { ok: true };
    }

    return { ok: false, error: "Unsupported relay command", status: 400 };
  }

  startServer() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        sendJson(res, 500, { ok: false, error: error.message || "Bridge request failed" });
      });
    });

    this.server.on("error", (error) => {
      this.error = error.message || "Bridge server failed";
      this.broadcast("bridge-error", { error: this.error, at: now() });
    });

    this.server.listen(this.settings.mobileBridgePort, this.settings.mobileBridgeHost);
  }

  stop() {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.disconnectRelay();
  }

  getStatus(includeSecret = false) {
    const port = Number(this.settings?.mobileBridgePort) || 8765;
    const bindHost = this.settings?.mobileBridgeHost || "127.0.0.1";
    const lanAddress = primaryLanAddress();
    const activeHost = bindHost === "0.0.0.0" ? lanAddress || "127.0.0.1" : bindHost;
    const token = this.settings?.mobileBridgeToken || "";
    const harnessStatus = this.harness.getStatus();

    return {
      enabled: Boolean(this.settings?.mobileBridgeEnabled),
      running: Boolean(this.server),
      error: this.error,
      bindHost,
      port,
      localUrl: `http://127.0.0.1:${port}`,
      lanUrl: `http://${activeHost}:${port}`,
      token: includeSecret ? token : undefined,
      tokenPreview: token ? `${token.slice(0, 6)}...${token.slice(-4)}` : "",
      relay: {
        enabled: Boolean(this.settings?.mobileBridgeEnabled),
        connected: Boolean(this.relay.connected),
        url: this.relay.url || normalizeRelayUrl(this.settings?.mobileRelayUrl || DEFAULT_RELAY_URL),
        sessionId: this.relay.sessionId,
        lastConnectedAt: this.relay.lastConnectedAt,
        lastError: this.relay.lastError
      },
      mobileRemoteControlEnabled: Boolean(this.settings?.mobileRemoteControlEnabled),
      updatePushEnabled: Boolean(this.settings?.updatePushEnabled),
      auth: this.getAuthPublicState(),
      sseClients: this.clients.size,
      terminalPreview: this.terminalBuffer.slice(-4000),
      lastTerminalAt: this.lastTerminalAt,
      lastUpdateNotice: this.lastUpdateNotice,
      harness: harnessStatus
    };
  }

  getAuthPublicState() {
    const account = this.authState.account;
    const activePairing = this.getActivePairing();

    return {
      desktopId: this.authState.desktopId,
      loggedIn: Boolean(account),
      account: account ? { ...account } : null,
      pairing: activePairing ? {
        active: true,
        codePreview: activePairing.codePreview,
        expiresAt: activePairing.expiresAt,
        createdAt: activePairing.createdAt,
        relaySessionId: activePairing.relaySessionId
      } : null,
      devices: this.authState.devices
        .filter((device) => device.enabled !== false)
        .map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          accountId: device.accountId,
          desktopId: device.desktopId || this.authState.desktopId,
          relaySessionId: device.relaySessionId || "",
          pushProvider: device.pushProvider,
          pushTokenPreview: device.pushToken ? `${device.pushToken.slice(0, 8)}...${device.pushToken.slice(-6)}` : "",
          pairedAt: device.pairedAt,
          lastSeenAt: device.lastSeenAt,
          enabled: device.enabled !== false
        }))
    };
  }

  getRequestTokens(req, url) {
    const authHeader = req.headers.authorization || "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    return [
      bearer,
      req.headers["x-deepseek-bridge-token"] || "",
      req.headers["x-deepseek-device-token"] || "",
      url.searchParams.get("token") || ""
    ].filter(Boolean);
  }

  resolveAuth(req, url) {
    const expected = this.settings?.mobileBridgeToken || "";
    if (!expected) {
      return { ok: false, admin: false, device: null };
    }
    const tokens = this.getRequestTokens(req, url);
    if (tokens.some((value) => safeEqual(value, expected))) {
      return { ok: true, admin: true, device: null };
    }

    const device = this.findDeviceByToken(tokens);
    if (device) {
      this.markDeviceSeen(device);
      return { ok: true, admin: false, device: this.publicDevice(device) };
    }

    return { ok: false, admin: false, device: null };
  }

  findDeviceByToken(tokens) {
    for (const token of tokens) {
      const tokenHash = hashSecret(token);
      const device = this.authState.devices.find((candidate) => (
        candidate.enabled !== false && candidate.tokenHash === tokenHash
      ));
      if (device) return device;
    }
    return null;
  }

  markDeviceSeen(device) {
    const previous = Date.parse(device.lastSeenAt || "0") || 0;
    if (Date.now() - previous < 30_000) return;
    device.lastSeenAt = now();
    this.writeAuthState();
  }

  publicDevice(device) {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      accountId: device.accountId,
      desktopId: device.desktopId || this.authState.desktopId,
      relaySessionId: device.relaySessionId || "",
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt
    };
  }

  loginAccount(payload) {
    const accountId = normalizeAccountId(payload.accountId || payload.email);
    if (!accountId) {
      return { ok: false, error: "Missing account id" };
    }

    this.authState.account = {
      accountId,
      email: normalizeAccountId(payload.email || accountId),
      displayName: trimString(payload.displayName || payload.name || accountId, 120),
      loggedInAt: now()
    };
    this.authState.activePairing = null;
    this.authState.pairing = null;
    this.writeAuthState();
    this.broadcast("auth-state", this.getAuthPublicState());
    return { ok: true, auth: this.getAuthPublicState(), status: this.getStatus(true) };
  }

  logoutAccount() {
    this.authState.account = null;
    this.authState.activePairing = null;
    this.authState.pairing = null;
    this.authState.devices = [];
    this.writeAuthState();
    this.broadcast("auth-state", this.getAuthPublicState());
    return { ok: true, auth: this.getAuthPublicState(), status: this.getStatus(true) };
  }

  startPairing() {
    if (!this.relay.connected) {
      return { ok: false, error: "Relay is not connected" };
    }

    const code = createPairingCode();
    const relaySessionId = this.relay.sessionId || randomId("relay");
    const pairing = {
      codeHash: hashSecret(code),
      codePreview: `${code.slice(0, 3)} ${code.slice(3)}`,
      expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString(),
      createdAt: now(),
      relaySessionId
    };
    this.authState.activePairing = pairing;
    this.authState.pairing = pairing;
    this.writeAuthState();
    this.publishPairingToRelay(pairing);
    this.broadcast("auth-state", this.getAuthPublicState());
    return {
      ok: true,
      pairing: {
        code,
        codePreview: pairing.codePreview,
        expiresAt: pairing.expiresAt,
        accountId: this.authState.account?.accountId,
        desktopId: this.authState.desktopId,
        relaySessionId
      },
      status: this.getStatus(true)
    };
  }

  pairDevice(payload) {
    const pairing = this.getActivePairing();
    if (!pairing) {
      return { ok: false, error: "No active pairing code" };
    }

    const codeHash = hashSecret(trimString(payload.pairingCode || payload.code, 32).replace(/\s+/g, ""));
    if (!safeEqual(codeHash, pairing.codeHash)) {
      return { ok: false, error: "Invalid pairing code" };
    }

    const deviceToken = createAuthToken();
    const device = {
      id: randomId("device"),
      accountId: normalizeAccountId(payload.accountId || payload.email) || "local",
      desktopId: this.authState.desktopId,
      relaySessionId: pairing.relaySessionId || "",
      name: trimString(payload.deviceName || payload.name || "Mobile device", 120),
      platform: trimString(payload.platform || "mobile", 40),
      clientDeviceId: trimString(payload.clientDeviceId || "", 160),
      pushProvider: trimString(payload.pushProvider || "", 40),
      pushToken: trimString(payload.pushToken || "", 500),
      tokenHash: hashSecret(deviceToken),
      pairedAt: now(),
      lastSeenAt: now(),
      enabled: true
    };

    this.authState.devices = this.authState.devices.filter((candidate) => (
      !device.clientDeviceId || candidate.clientDeviceId !== device.clientDeviceId
    ));
    this.authState.devices.push(device);
    this.authState.activePairing = null;
    this.authState.pairing = null;
    this.writeAuthState();
    this.broadcast("auth-state", this.getAuthPublicState());

    return {
      ok: true,
      device: this.publicDevice(device),
      deviceToken,
      deviceId: device.id,
      desktopId: this.authState.desktopId,
      relaySessionId: device.relaySessionId,
      status: this.getStatus(false)
    };
  }

  revokeDevice(deviceId) {
    const device = this.authState.devices.find((candidate) => candidate.id === deviceId);
    if (!device) {
      return { ok: false, error: "Device not found" };
    }
    device.enabled = false;
    device.revokedAt = now();
    this.writeAuthState();
    this.broadcast("auth-state", this.getAuthPublicState());
    return { ok: true, auth: this.getAuthPublicState(), status: this.getStatus(true) };
  }

  allowPairingAttempt(req) {
    const key = req.socket.remoteAddress || "unknown";
    const current = this.pairingAttempts.get(key);
    if (!current || current.expiresAt <= Date.now()) {
      this.pairingAttempts.set(key, { count: 1, expiresAt: Date.now() + PAIRING_ATTEMPT_TTL_MS });
      return true;
    }
    current.count += 1;
    return current.count <= MAX_PAIRING_ATTEMPTS;
  }

  async handleRequest(req, res) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/api/v1/health") {
      sendJson(res, 200, { ok: true, requiresAuth: true, at: now() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/auth/pair") {
      if (!this.allowPairingAttempt(req)) {
        sendJson(res, 429, { ok: false, error: "Too many pairing attempts" });
        return;
      }

      const body = await readJsonBody(req);
      const result = this.pairDevice(body);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    const auth = this.resolveAuth(req, url);
    if (!auth.ok) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/status") {
      sendJson(res, 200, { ok: true, status: this.getStatus(false), auth: auth.device });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/auth/state") {
      sendJson(res, 200, { ok: true, auth: this.getAuthPublicState(), requester: auth.device });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/auth/login") {
      this.requireAdmin(auth, res);
      if (res.writableEnded) return;

      const body = await readJsonBody(req);
      const result = this.loginAccount(body);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
      this.requireAdmin(auth, res);
      if (res.writableEnded) return;

      sendJson(res, 200, this.logoutAccount());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/auth/pairing/start") {
      this.requireAdmin(auth, res);
      if (res.writableEnded) return;

      const result = this.startPairing();
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/devices/revoke") {
      this.requireAdmin(auth, res);
      if (res.writableEnded) return;

      const body = await readJsonBody(req);
      const result = this.revokeDevice(trimString(body.deviceId || body.id, 120));
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/events") {
      this.openEventStream(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/session/start") {
      this.requireControl(res);
      if (res.writableEnded) return;

      const body = await readJsonBody(req);
      const settings = this.harness.readSettings();
      const options = {
        ...settings,
        ...(body.options && typeof body.options === "object" ? body.options : {}),
        launchAction: normalizeAction(body.action),
        agentPrompt: trimString(body.prompt, 12000)
      };
      const result = this.harness.start(options);
      this.broadcast("bridge-status", this.getStatus(false));
      sendJson(res, result.ok ? 200 : 400, { ok: Boolean(result.ok), result, status: this.getStatus(false) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/session/stop") {
      this.requireControl(res);
      if (res.writableEnded) return;

      const result = this.harness.stop();
      this.broadcast("bridge-status", this.getStatus(false));
      sendJson(res, 200, { ok: true, result, status: this.getStatus(false) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/terminal/input") {
      this.requireControl(res);
      if (res.writableEnded) return;

      const body = await readJsonBody(req);
      const data = typeof body.data === "string" ? body.data : "";
      if (!data) {
        sendJson(res, 400, { ok: false, error: "Missing terminal input data" });
        return;
      }
      this.harness.input(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/skills/upsert") {
      this.requireControl(res);
      if (res.writableEnded) return;

      const body = await readJsonBody(req);
      const settings = this.harness.readSettings();
      const result = this.harness.createSkillTemplate({
        settings,
        skillId: trimString(body.skillId || body.id || "", 120),
        name: trimString(body.name || body.title || "", 160),
        description: trimString(body.description || body.trigger || "", 700),
        content: trimString(body.content || body.markdown || "", 120000)
      });
      if (result.ok && result.skill && body.enable !== false) {
        const nextSettings = {
          ...settings,
          enabledSkills: Array.from(new Set([...(settings.enabledSkills || []), result.skill.id]))
        };
        this.harness.writeSettings(nextSettings);
        this.settings = { ...this.settings, ...nextSettings };
      }
      this.broadcast("skills-updated", { result, at: now() });
      this.broadcast("bridge-status", this.getStatus(false));
      sendJson(res, result.ok ? 200 : 400, { ...result, status: this.getStatus(false) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/updates/push") {
      this.requireAdmin(auth, res);
      if (res.writableEnded) return;

      const body = await readJsonBody(req);
      const result = this.publishUpdateNotice(body, "mobile-api");
      sendJson(res, result.ok ? 200 : 403, result);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  }

  requireControl(res) {
    if (!this.settings?.mobileRemoteControlEnabled) {
      sendJson(res, 403, { ok: false, error: "Remote control is disabled on this desktop" });
    }
  }

  requireAdmin(auth, res) {
    if (!auth.admin) {
      sendJson(res, 403, { ok: false, error: "Desktop admin token is required" });
    }
  }

  openEventStream(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    this.clients.add(res);
    this.writeEvent(res, "snapshot", this.getStatus(false));
    if (this.terminalBuffer) {
      this.writeEvent(res, "terminal-replay", {
        data: this.terminalBuffer.slice(-12000),
        at: this.lastTerminalAt
      });
    }
    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  writeEvent(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcast(eventName, payload) {
    for (const client of this.clients) {
      this.writeEvent(client, eventName, payload);
    }
  }

  handleTerminalData(data) {
    this.lastTerminalAt = now();
    this.terminalBuffer += String(data || "");
    if (this.terminalBuffer.length > MAX_TERMINAL_CHARS) {
      this.terminalBuffer = this.terminalBuffer.slice(-MAX_TERMINAL_CHARS);
    }
    this.broadcast("terminal", {
      data,
      at: this.lastTerminalAt,
      session: this.harness.getStatus().activeSession
    });
  }

  handleTerminalExit(exit) {
    this.broadcast("terminal-exit", { ...exit, at: now() });
    this.broadcast("bridge-status", this.getStatus(false));
  }

  publishUpdateNotice(payload, source = "desktop") {
    if (!this.settings?.updatePushEnabled) {
      return { ok: false, error: "Update push notifications are disabled" };
    }
    const requestedAccountId = normalizeAccountId(payload.accountId || payload.email);
    const accountId = this.authState.account?.accountId || "";
    if (requestedAccountId && !safeEqual(requestedAccountId, accountId)) {
      return { ok: false, error: "Update push account mismatch" };
    }

    const notice = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      source,
      accountId,
      matchedDeviceIds: this.authState.devices
        .filter((device) => device.enabled !== false && (!accountId || device.accountId === accountId))
        .map((device) => device.id),
      version: trimString(payload.version || payload.release || "", 80),
      title: trimString(payload.title || "DeepSeek TUI Desktop update", 120),
      body: trimString(payload.body || payload.message || "A desktop update is available.", 800),
      url: trimString(payload.url || payload.downloadUrl || "", 500),
      createdAt: now()
    };

    this.lastUpdateNotice = notice;
    this.broadcast("update-notice", notice);

    if (Notification.isSupported()) {
      const notification = new Notification({
        title: notice.title,
        body: notice.version ? `${notice.version}: ${notice.body}` : notice.body
      });
      notification.show();
    }

    return { ok: true, notice };
  }
}

module.exports = {
  DesktopRemoteBridge
};
