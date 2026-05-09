#!/usr/bin/env node
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const { DeepSeekDesktopHarness } = require("./harness.cjs");

const userDataPath = process.env.DEEPSEEK_DESKTOP_USER_DATA || path.join(os.homedir(), "Library", "Application Support", "deepseek-tui-desktop");
const appRoot = process.env.DEEPSEEK_DESKTOP_APP_ROOT || path.resolve(__dirname, "..");

const harness = new DeepSeekDesktopHarness({
  getPath(name) {
    if (name === "userData") return userDataPath;
    if (name === "home") return os.homedir();
    return userDataPath;
  },
  getAppPath() {
    return appRoot;
  }
});

const tools = [
  {
    name: "automation_create",
    description: "Create or activate a DeepSeek TUI Desktop scheduled Agent task. Use this for normal user requests like daily, hourly, recurring, remind me, or run later.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional short task name." },
        prompt: { type: "string", description: "The Agent prompt to run on schedule." },
        workspacePath: { type: "string", description: "Workspace directory. Defaults to the current desktop workspace." },
        hour: { type: "integer", minimum: 0, maximum: 23, description: "Local wall-clock hour." },
        minute: { type: "integer", minimum: 0, maximum: 59, description: "Local wall-clock minute." },
        timezone: { type: "string", description: "IANA timezone. Defaults to the system timezone." },
        status: { type: "string", enum: ["ACTIVE", "PAUSED"], description: "Defaults to ACTIVE." }
      },
      required: ["prompt", "hour", "minute"]
    }
  },
  {
    name: "automation_list",
    description: "List DeepSeek TUI Desktop scheduled Agent tasks.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "automation_pause",
    description: "Pause a DeepSeek TUI Desktop scheduled Agent task.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id." }
      },
      required: ["id"]
    }
  },
  {
    name: "automation_delete",
    description: "Delete a DeepSeek TUI Desktop scheduled Agent task.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id." }
      },
      required: ["id"]
    }
  }
];

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function toolResult(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: result?.ok === false
  };
}

function handleRequest(frame) {
  const { id, method, params = {} } = frame;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "deepseek-desktop-automation", version: "1.0.0" }
      }
    });
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }

  if (method === "tools/call") {
    const name = String(params.name || "");
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    try {
      send({
        jsonrpc: "2.0",
        id,
        result: toolResult(harness.callAutomationBridgeTool(name, args))
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        result: toolResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error || "Automation tool failed.")
        })
      });
    }
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unsupported method: ${method}` }
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = String(line || "").trim();
  if (!text) return;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON" } });
    return;
  }
  if (!Object.hasOwn(frame, "id")) {
    return;
  }
  handleRequest(frame);
});
