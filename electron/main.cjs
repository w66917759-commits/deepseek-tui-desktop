const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { DeepSeekDesktopHarness } = require("./harness.cjs");
const { DesktopRemoteBridge } = require("./remoteBridge.cjs");

let mainWindow = null;
let harness = null;
let remoteBridge = null;

const isDev = !app.isPackaged;

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

function sendRemoteStatus() {
  if (remoteBridge && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("remote:status", remoteBridge.getStatus(true));
  }
  if (remoteBridge) {
    remoteBridge.broadcast("bridge-status", remoteBridge.getStatus(false));
  }
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

function registerIpc() {
  ipcMain.handle("settings:get", () => harness.readSettings());

  ipcMain.handle("settings:save", (_event, settings) => {
    const saved = harness.writeSettings(settings);
    remoteBridge.configure(saved);
    sendRemoteStatus();
    return saved;
  });

  ipcMain.handle("api-key:get", (_event, provider) => harness.readApiKey(provider));

  ipcMain.handle("api-key:save", (_event, payload) => harness.saveApiKey(payload));

  ipcMain.handle("customization:get", (_event, settings) => harness.readCustomization(settings));

  ipcMain.handle("skills:save-template", (_event, payload) => harness.saveSkillTemplate(payload));

  ipcMain.handle("skills:create-template", (_event, payload) => harness.createSkillTemplate(payload));

  ipcMain.handle("skills:import-directory", (_event, payload) => harness.importSkillDirectory(payload));

  ipcMain.handle("mcp:save-config", (_event, payload) => harness.saveMcpConfig(payload));

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

  ipcMain.handle("git:status", (_event, workspacePath) => harness.gitStatus(workspacePath));

  ipcMain.handle("git:init", (_event, workspacePath) => harness.gitInit(workspacePath));

  ipcMain.handle("git:set-remote", (_event, payload) => harness.gitSetRemote(payload));

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

  harness.on("terminal:data", (data) => {
    sendTerminalData(data);
    remoteBridge.handleTerminalData(data);
  });
  harness.on("terminal:exit", (exit) => {
    sendTerminalExit(exit);
    remoteBridge.handleTerminalExit(exit);
    sendRemoteStatus();
  });

  createWindow();
  registerIpc();
  remoteBridge.configure(harness.readSettings());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (remoteBridge) {
    remoteBridge.stop();
  }
  if (harness) {
    harness.shutdown();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
