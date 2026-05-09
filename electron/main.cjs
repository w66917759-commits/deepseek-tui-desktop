const { app, BrowserWindow, Notification, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");
const { DeepSeekDesktopHarness } = require("./harness.cjs");
const { DesktopRemoteBridge } = require("./remoteBridge.cjs");
const { AppServerClient } = require("./appServerClient.cjs");
const { RuntimeOrchestrator, createDeepSeekCliRunner } = require("./runtimeOrchestrator.cjs");
const { RuntimeApiService } = require("./runtimeApiService.cjs");

let mainWindow = null;
let harness = null;
let remoteBridge = null;
let appServerClient = null;
let orchestrator = null;
let runtimeApiService = null;

const isDev = !app.isPackaged;
const DEFAULT_RUNTIME_SESSION_CONCURRENCY = 8;
const DESKTOP_UPDATE_REPO = "w66917759-commits/deepseek-tui-desktop";
const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DESKTOP_UPDATE_INITIAL_DELAY_MS = 8_000;

let desktopUpdateTimer = null;
let desktopUpdateInitialTimer = null;
let lastNotifiedDesktopUpdateTag = "";

const EDITOR_OPENERS = {
  cursor: {
    label: "Cursor",
    macAppName: "Cursor",
    cliCommands: process.platform === "win32" ? ["cursor.cmd", "cursor"] : ["cursor"]
  },
  vscode: {
    label: "VS Code",
    macAppName: "Visual Studio Code",
    cliCommands: process.platform === "win32" ? ["code.cmd", "code"] : ["code"]
  }
};

function runOpenCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    windowsHide: true
  });

  if (result.error) {
    return {
      ok: false,
      missing: result.error.code === "ENOENT",
      error: result.error.message
    };
  }

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      missing: /not found|unable to find|not recognized|ENOENT/i.test(message),
      error: message || `${command} exited with status ${result.status}`
    };
  }

  return { ok: true };
}

function openWithCli(editor, workspacePath) {
  let lastError = "";
  for (const command of editor.cliCommands) {
    const result = runOpenCommand(command, [workspacePath]);
    if (result.ok) {
      return { ok: true, command };
    }
    lastError = result.error || lastError;
    if (!result.missing) {
      break;
    }
  }
  return { ok: false, error: lastError };
}

function openWorkspaceEditor(payload = {}) {
  const editor = EDITOR_OPENERS[payload.editor];
  if (!editor) {
    return { ok: false, error: "Unsupported editor" };
  }

  const requestedPath = typeof payload.workspacePath === "string" ? payload.workspacePath.trim() : "";
  if (!requestedPath) {
    return { ok: false, error: "Choose a workspace before opening an editor." };
  }

  const workspacePath = path.resolve(requestedPath);
  if (!fs.existsSync(workspacePath)) {
    return { ok: false, error: `Workspace does not exist: ${workspacePath}` };
  }

  const stat = fs.statSync(workspacePath);
  if (!stat.isDirectory() && !stat.isFile()) {
    return { ok: false, error: `Workspace is not a file or directory: ${workspacePath}` };
  }

  if (process.platform === "darwin") {
    const appResult = runOpenCommand("open", ["-a", editor.macAppName, workspacePath]);
    if (appResult.ok) {
      return { ok: true, editor: payload.editor, path: workspacePath, command: `open -a ${editor.macAppName}` };
    }

    const cliResult = openWithCli(editor, workspacePath);
    if (cliResult.ok) {
      return { ok: true, editor: payload.editor, path: workspacePath, command: cliResult.command };
    }

    return {
      ok: false,
      error: `${editor.label} is not installed or its command is not available. ${appResult.error || cliResult.error || ""}`.trim()
    };
  }

  const cliResult = openWithCli(editor, workspacePath);
  if (cliResult.ok) {
    return { ok: true, editor: payload.editor, path: workspacePath, command: cliResult.command };
  }

  return {
    ok: false,
    error: `${editor.label} command is not available. Install ${editor.label} or add '${editor.cliCommands[0]}' to PATH.`
  };
}

function sendTerminalData(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal:data", data);
  }
}

function sendTerminalExit(exit) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("terminal:exit", exit);
  }
}

function sendRuntimeSnapshot(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtime:snapshot", snapshot);
  }
}

function sendRuntimeEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtime:event", event);
  }
}

function sendRuntimeOrchestratorSnapshot(snapshot) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtime:orchestratorSnapshot", snapshot);
  }
}

function sendRuntimeTurnEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtime:turnEvent", event);
  }
}

function sendRuntimeApiStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtimeApi:status", status);
  }
}

function sendRemoteStatus() {
  if (remoteBridge && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("remote:status", remoteBridge.getStatus(true));
  }
  if (remoteBridge) {
    remoteBridge.broadcast("bridge-status", remoteBridge.getStatus(false));
  }
}

function sendDesktopUpdateAvailable(update) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktopUpdate:available", update);
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `DeepSeek-TUI-Desktop/${app.getVersion()}`
      },
      timeout: 12_000
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode || 0}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Update check timed out."));
    });
    request.on("error", reject);
  });
}

function versionParts(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
}

function isNewerVersion(candidate, current) {
  const next = versionParts(candidate);
  const now = versionParts(current);
  for (let index = 0; index < Math.max(next.length, now.length, 3); index += 1) {
    const nextPart = next[index] || 0;
    const nowPart = now[index] || 0;
    if (nextPart > nowPart) return true;
    if (nextPart < nowPart) return false;
  }
  return false;
}

function releaseToDesktopUpdate(release) {
  const tagName = String(release?.tag_name || "");
  const version = tagName.replace(/^v/i, "") || String(release?.name || "");
  if (!tagName || !isNewerVersion(version, app.getVersion())) {
    return null;
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const dmgAsset = assets.find((asset) => /\.dmg$/i.test(String(asset?.name || "")));
  const releaseUrl = String(release.html_url || `https://github.com/${DESKTOP_UPDATE_REPO}/releases/tag/${tagName}`);
  return {
    currentVersion: app.getVersion(),
    version,
    tagName,
    name: String(release.name || tagName),
    releaseUrl,
    downloadUrl: String(dmgAsset?.browser_download_url || releaseUrl),
    assetName: String(dmgAsset?.name || ""),
    publishedAt: String(release.published_at || release.created_at || "")
  };
}

function notifyDesktopUpdate(update) {
  if (!update || lastNotifiedDesktopUpdateTag === update.tagName) return;
  lastNotifiedDesktopUpdateTag = update.tagName;
  sendDesktopUpdateAvailable(update);

  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `DeepSeek TUI Desktop ${update.version}`,
    body: "新版本已经发布，点击打开下载页面。"
  });
  notification.on("click", () => {
    shell.openExternal(update.downloadUrl || update.releaseUrl).catch(() => undefined);
  });
  notification.show();
}

async function checkDesktopUpdate(options = {}) {
  try {
    const release = await fetchJson(`https://api.github.com/repos/${DESKTOP_UPDATE_REPO}/releases/latest`);
    const update = releaseToDesktopUpdate(release);
    if (update && !options.silent) {
      notifyDesktopUpdate(update);
    } else if (update) {
      sendDesktopUpdateAvailable(update);
    }
    return {
      ok: true,
      currentVersion: app.getVersion(),
      update
    };
  } catch (error) {
    return {
      ok: false,
      currentVersion: app.getVersion(),
      update: null,
      error: error instanceof Error ? error.message : String(error || "Update check failed.")
    };
  }
}

function startDesktopUpdateChecks() {
  if (desktopUpdateTimer) return;
  desktopUpdateInitialTimer = setTimeout(() => {
    desktopUpdateInitialTimer = null;
    checkDesktopUpdate({ silent: false }).catch(() => undefined);
  }, DESKTOP_UPDATE_INITIAL_DELAY_MS);
  desktopUpdateTimer = setInterval(() => {
    checkDesktopUpdate({ silent: false }).catch(() => undefined);
  }, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
}

function stopDesktopUpdateChecks() {
  if (desktopUpdateInitialTimer) {
    clearTimeout(desktopUpdateInitialTimer);
    desktopUpdateInitialTimer = null;
  }
  if (!desktopUpdateTimer) return;
  clearInterval(desktopUpdateTimer);
  desktopUpdateTimer = null;
}

function launchActionForTurnMode(mode) {
  if (mode === "plan") return "plan";
  if (mode === "yolo") return "yolo";
  return "exec";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: "DeepSeek TUI Desktop",
    backgroundColor: "#f5f5f7",
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: "sidebar",
      visualEffectState: "active"
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function createOrchestrator() {
  const settings = harness.readSettings();
  const workspacePath = settings.workspacePath || app.getPath("userData");
  const runtime = harness.resolveRuntime(settings);
  const env = harness.buildEnv(settings, workspacePath);
  fs.mkdirSync(app.getPath("userData"), { recursive: true });

  appServerClient = new AppServerClient({
    command: runtime.selected,
    args: ["app-server", "--stdio"],
    cwd: app.getPath("userData"),
    env,
    requestTimeoutMs: 60_000
  });
  appServerClient.on("event", (event) => {
    sendRuntimeTurnEvent({ ...event, source: "app-server" });
  });
  appServerClient.on("stderr", (data) => {
    sendRuntimeTurnEvent({
      type: "app-server-stderr",
      detail: String(data || ""),
      at: new Date().toISOString()
    });
  });
  appServerClient.on("error", (error) => {
    sendRuntimeTurnEvent({
      type: "app-server-error",
      detail: error instanceof Error ? error.message : String(error || ""),
      at: new Date().toISOString()
    });
  });
  appServerClient.on("exit", (exit) => {
    sendRuntimeTurnEvent({
      type: "app-server-exit",
      detail: `code=${exit.code ?? "null"}${exit.signal ? ` signal=${exit.signal}` : ""}`,
      at: new Date().toISOString()
    });
  });

  orchestrator = new RuntimeOrchestrator({
    client: appServerClient,
    runner: (turn, conversation, emitEvent) => {
      const latestSettings = harness.readSettings();
      const requestedSettings = turn.settings && typeof turn.settings === "object" ? turn.settings : {};
      const launchPlan = harness.buildLaunchPlan({
        ...latestSettings,
        ...requestedSettings,
        provider: turn.provider || requestedSettings.provider || latestSettings.provider,
        model: turn.model || requestedSettings.model || latestSettings.model,
        baseUrl: turn.baseUrl || requestedSettings.baseUrl || latestSettings.baseUrl,
        workspacePath: conversation.workspacePath || workspacePath,
        launchAction: launchActionForTurnMode(turn.mode),
        agentPrompt: turn.prompt
      });
      return createDeepSeekCliRunner({
        command: launchPlan.command,
        args: launchPlan.args,
        cwd: launchPlan.cwd,
        env: launchPlan.env
      })(turn, conversation, emitEvent);
    },
    maxConcurrentSessions: DEFAULT_RUNTIME_SESSION_CONCURRENCY
  });
  orchestrator.on("runtime:snapshot", sendRuntimeOrchestratorSnapshot);
  orchestrator.on("runtime:event", sendRuntimeTurnEvent);
  for (const type of ["turn-started", "turn-completed", "turn-failed", "turn-cancelled"]) {
    orchestrator.on(type, (turn) => {
      sendRuntimeTurnEvent({ ...turn, type, at: new Date().toISOString() });
    });
  }
  return orchestrator;
}

function getOrchestrator() {
  return orchestrator || createOrchestrator();
}

function registerIpc() {
  ipcMain.handle("settings:get", () => harness.readSettings());

  ipcMain.handle("app:open-external", async (_event, url) => {
    const value = String(url || "").trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, error: "Only http and https URLs can be opened." };
      }
      await shell.openExternal(parsed.toString());
      return { ok: true, url: parsed.toString() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Invalid URL" };
    }
  });

  ipcMain.handle("desktopUpdate:check", (_event, payload = {}) => checkDesktopUpdate({
    silent: Boolean(payload?.silent)
  }));

  ipcMain.handle("settings:save", (_event, settings) => {
    const saved = harness.writeSettings(settings);
    remoteBridge.configure(saved);
    sendRemoteStatus();
    return saved;
  });

  ipcMain.handle("api-key:get", (_event, provider) => harness.readApiKey(provider));

  ipcMain.handle("api-key:save", (_event, payload) => harness.saveApiKey(payload));

  ipcMain.handle("customization:get", (_event, settings) => harness.readCustomization(settings));

  ipcMain.handle("skills:create-template", (_event, payload) => harness.createSkillTemplate(payload));

  ipcMain.handle("skills:import-directory", (_event, payload) => harness.importSkillDirectory(payload));

  ipcMain.handle("mcp:save-config", (_event, payload) => harness.saveMcpConfig(payload));

  ipcMain.handle("mcp:save-env-secret", (_event, payload) => harness.saveMcpEnvSecret(payload));

  ipcMain.handle("mcp:test", (_event, payload) => harness.testMcpServers(payload));

  ipcMain.handle("history:get", () => harness.readConversationHistory());

  ipcMain.handle("history:save", (_event, history) => harness.writeConversationHistory(history));

  ipcMain.handle("automations:get", () => harness.readAutomations());

  ipcMain.handle("automations:save", (_event, payload) => harness.saveAutomation(payload));

  ipcMain.handle("automations:delete", (_event, payload) => harness.deleteAutomation(payload));

  ipcMain.handle("automations:install", (_event, payload) => harness.installAutomation(payload));

  ipcMain.handle("automations:uninstall", (_event, payload) => harness.uninstallAutomation(payload));

  ipcMain.handle("dialog:choose-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? "" : result.filePaths[0];
  });

  ipcMain.handle("dialog:choose-file", async (_event, filters) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: filters || []
    });
    return result.canceled ? "" : result.filePaths[0];
  });

  ipcMain.handle("editor:open", (_event, payload) => openWorkspaceEditor(payload));

  ipcMain.handle("runtime:check", (_event, partialSettings) => harness.checkRuntime(partialSettings));

  ipcMain.handle("runtime:snapshot", () => harness.getRuntimeSnapshot());

  ipcMain.handle("runtime:orchestratorSnapshot", () => getOrchestrator().snapshot());

  ipcMain.handle("runtime:startTurn", (_event, payload = {}) => {
    const runtime = harness.checkRuntime(payload.settings || harness.readSettings());
    if (!runtime.selectedExists) {
      return { ok: false, error: "Runtime not found", runtime };
    }
    const orchestrator = getOrchestrator();
    return orchestrator.startTurn(payload);
  });

  ipcMain.handle("runtime:cancelTurn", (_event, payload = {}) => getOrchestrator().cancelTurn(payload));

  ipcMain.handle("runtimeApi:getStatus", (_event, settings) => runtimeApiService.getStatus(settings));

  ipcMain.handle("runtimeApi:getInfo", (_event, settings) => runtimeApiService.getInfo(settings));

  ipcMain.handle("runtimeApi:listSkills", (_event, settings) => runtimeApiService.listSkills(settings));

  ipcMain.handle("runtimeApi:setSkillEnabled", (_event, payload) => runtimeApiService.setSkillEnabled(payload));

  ipcMain.handle("runtimeApi:listMcpServers", (_event, settings) => runtimeApiService.listMcpServers(settings));

  ipcMain.handle("runtimeApi:decideApproval", (_event, payload) => runtimeApiService.decideApproval(payload));

  ipcMain.handle("git:status", (_event, workspacePath) => harness.gitStatus(workspacePath));

  ipcMain.handle("git:init", (_event, workspacePath) => harness.gitInit(workspacePath));

  ipcMain.handle("git:set-remote", (_event, payload) => harness.gitSetRemote(payload));

  ipcMain.handle("git:switch-branch", (_event, payload) => harness.gitSwitchBranch(payload));

  ipcMain.handle("git:fetch", (_event, payload) => harness.gitRunWorkspaceAction(payload, "fetch"));

  ipcMain.handle("git:pull", (_event, payload) => harness.gitRunWorkspaceAction(payload, "pull"));

  ipcMain.handle("git:push", (_event, payload) => harness.gitRunWorkspaceAction(payload, "push"));

  ipcMain.handle("git:commit", (_event, payload) => harness.gitCommit(payload));

  ipcMain.handle("git:diff-summary", (_event, payload) => harness.gitDiffSummary(payload));

  ipcMain.handle("terminal:start", (_event, options) => {
    const result = harness.start(options);
    sendRemoteStatus();
    return result;
  });

  ipcMain.handle("terminal:stop", () => {
    const result = harness.stop();
    sendRemoteStatus();
    return result;
  });

  ipcMain.on("terminal:input", (_event, data) => harness.input(data));

  ipcMain.on("terminal:resize", (_event, size) => harness.resize(size));

  ipcMain.handle("remote:status", () => remoteBridge.getStatus(true));

  ipcMain.handle("remote:restart", () => {
    const status = remoteBridge.configure(harness.readSettings());
    sendRemoteStatus();
    return status;
  });

  ipcMain.handle("remote:rotate-token", () => {
    const settings = harness.rotateRemoteToken();
    const status = remoteBridge.configure(settings);
    sendRemoteStatus();
    return { settings, status };
  });

  ipcMain.handle("remote:login", (_event, payload) => {
    const result = remoteBridge.loginAccount(payload || {});
    sendRemoteStatus();
    return result;
  });

  ipcMain.handle("remote:logout", () => {
    const result = remoteBridge.logoutAccount();
    sendRemoteStatus();
    return result;
  });

  ipcMain.handle("remote:pairing-start", () => {
    const result = remoteBridge.startPairing();
    sendRemoteStatus();
    return result;
  });

  ipcMain.handle("remote:device-revoke", (_event, deviceId) => {
    const result = remoteBridge.revokeDevice(deviceId);
    sendRemoteStatus();
    return result;
  });

  ipcMain.handle("updates:push", (_event, payload) => {
    const result = remoteBridge.publishUpdateNotice(payload || {}, "desktop-ui");
    sendRemoteStatus();
    return result;
  });
}

app.whenReady().then(() => {
  harness = new DeepSeekDesktopHarness(app);
  remoteBridge = new DesktopRemoteBridge(app, harness);
  runtimeApiService = new RuntimeApiService({ app, harness });
  runtimeApiService.on("status", sendRuntimeApiStatus);
  createOrchestrator();

  harness.on("terminal:data", (data) => {
    sendTerminalData(data);
    remoteBridge.handleTerminalData(data);
  });
  harness.on("terminal:exit", (exit) => {
    sendTerminalExit(exit);
    remoteBridge.handleTerminalExit(exit);
    sendRemoteStatus();
  });
  harness.on("runtime:snapshot", (snapshot) => {
    sendRuntimeSnapshot(snapshot);
  });
  harness.on("runtime:event", (event) => {
    sendRuntimeEvent(event);
  });

  createWindow();
  registerIpc();
  remoteBridge.configure(harness.readSettings());
  startDesktopUpdateChecks();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopDesktopUpdateChecks();
  if (remoteBridge) {
    remoteBridge.stop();
  }
  if (harness) {
    harness.shutdown();
  }
  if (appServerClient) {
    appServerClient.close().catch(() => undefined);
  }
  if (runtimeApiService) {
    runtimeApiService.stop().catch(() => undefined);
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
