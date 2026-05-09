const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepseekDesktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  checkDesktopUpdate: (options) => ipcRenderer.invoke("desktopUpdate:check", options),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getApiKey: (provider) => ipcRenderer.invoke("api-key:get", provider),
  saveApiKey: (payload) => ipcRenderer.invoke("api-key:save", payload),
  getCustomization: (settings) => ipcRenderer.invoke("customization:get", settings),
  createSkillTemplate: (payload) => ipcRenderer.invoke("skills:create-template", payload),
  importSkillDirectory: (payload) => ipcRenderer.invoke("skills:import-directory", payload),
  saveMcpConfig: (payload) => ipcRenderer.invoke("mcp:save-config", payload),
  saveMcpEnvSecret: (payload) => ipcRenderer.invoke("mcp:save-env-secret", payload),
  testMcpServers: (payload) => ipcRenderer.invoke("mcp:test", payload),
  getConversationHistory: () => ipcRenderer.invoke("history:get"),
  saveConversationHistory: (history) => ipcRenderer.invoke("history:save", history),
  getAutomations: () => ipcRenderer.invoke("automations:get"),
  saveAutomation: (payload) => ipcRenderer.invoke("automations:save", payload),
  deleteAutomation: (payload) => ipcRenderer.invoke("automations:delete", payload),
  installAutomation: (payload) => ipcRenderer.invoke("automations:install", payload),
  uninstallAutomation: (payload) => ipcRenderer.invoke("automations:uninstall", payload),
  chooseDirectory: () => ipcRenderer.invoke("dialog:choose-directory"),
  chooseFile: (filters) => ipcRenderer.invoke("dialog:choose-file", filters),
  openWorkspaceEditor: (options) => ipcRenderer.invoke("editor:open", options),
  checkRuntime: (settings) => ipcRenderer.invoke("runtime:check", settings),
  getRuntimeSnapshot: () => ipcRenderer.invoke("runtime:snapshot"),
  getRuntimeOrchestratorSnapshot: () => ipcRenderer.invoke("runtime:orchestratorSnapshot"),
  startRuntimeTurn: (payload) => ipcRenderer.invoke("runtime:startTurn", payload),
  cancelRuntimeTurn: (payload) => ipcRenderer.invoke("runtime:cancelTurn", payload),
  getRuntimeApiStatus: (settings) => ipcRenderer.invoke("runtimeApi:getStatus", settings),
  getRuntimeApiInfo: (settings) => ipcRenderer.invoke("runtimeApi:getInfo", settings),
  listRuntimeApiSkills: (settings) => ipcRenderer.invoke("runtimeApi:listSkills", settings),
  setRuntimeApiSkillEnabled: (payload) => ipcRenderer.invoke("runtimeApi:setSkillEnabled", payload),
  listRuntimeApiMcpServers: (settings) => ipcRenderer.invoke("runtimeApi:listMcpServers", settings),
  decideRuntimeApiApproval: (payload) => ipcRenderer.invoke("runtimeApi:decideApproval", payload),
  getGitStatus: (workspacePath) => ipcRenderer.invoke("git:status", workspacePath),
  initGitRepository: (workspacePath) => ipcRenderer.invoke("git:init", workspacePath),
  setGitRemote: (payload) => ipcRenderer.invoke("git:set-remote", payload),
  switchGitBranch: (payload) => ipcRenderer.invoke("git:switch-branch", payload),
  fetchGitRepository: (payload) => ipcRenderer.invoke("git:fetch", payload),
  pullGitRepository: (payload) => ipcRenderer.invoke("git:pull", payload),
  pushGitRepository: (payload) => ipcRenderer.invoke("git:push", payload),
  commitGitRepository: (payload) => ipcRenderer.invoke("git:commit", payload),
  getGitDiffSummary: (payload) => ipcRenderer.invoke("git:diff-summary", payload),
  startTerminal: (options) => ipcRenderer.invoke("terminal:start", options),
  stopTerminal: () => ipcRenderer.invoke("terminal:stop"),
  sendTerminalInput: (data) => ipcRenderer.send("terminal:input", data),
  resizeTerminal: (size) => ipcRenderer.send("terminal:resize", size),
  getRemoteStatus: () => ipcRenderer.invoke("remote:status"),
  restartRemoteBridge: () => ipcRenderer.invoke("remote:restart"),
  rotateRemoteToken: () => ipcRenderer.invoke("remote:rotate-token"),
  loginRemoteAccount: (payload) => ipcRenderer.invoke("remote:login", payload),
  logoutRemoteAccount: () => ipcRenderer.invoke("remote:logout"),
  startRemotePairing: () => ipcRenderer.invoke("remote:pairing-start"),
  revokeRemoteDevice: (deviceId) => ipcRenderer.invoke("remote:device-revoke", deviceId),
  pushUpdateNotice: (payload) => ipcRenderer.invoke("updates:push", payload),
  onTerminalData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, exit) => callback(exit);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  onRuntimeSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("runtime:snapshot", listener);
    return () => ipcRenderer.removeListener("runtime:snapshot", listener);
  },
  onRuntimeEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("runtime:event", listener);
    return () => ipcRenderer.removeListener("runtime:event", listener);
  },
  onRuntimeOrchestratorSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("runtime:orchestratorSnapshot", listener);
    return () => ipcRenderer.removeListener("runtime:orchestratorSnapshot", listener);
  },
  onRuntimeTurnEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("runtime:turnEvent", listener);
    return () => ipcRenderer.removeListener("runtime:turnEvent", listener);
  },
  onRuntimeApiStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("runtimeApi:status", listener);
    return () => ipcRenderer.removeListener("runtimeApi:status", listener);
  },
  onRemoteStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("remote:status", listener);
    return () => ipcRenderer.removeListener("remote:status", listener);
  },
  onDesktopUpdateAvailable: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("desktopUpdate:available", listener);
    return () => ipcRenderer.removeListener("desktopUpdate:available", listener);
  }
});
