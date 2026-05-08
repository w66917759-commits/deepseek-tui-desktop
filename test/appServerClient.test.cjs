const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AppServerClient } = require("../electron/appServerClient.cjs");

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeFakeAppServer(root) {
  const scriptPath = path.join(root, "fake-app-server.cjs");
  fs.writeFileSync(scriptPath, [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "function send(frame) { process.stdout.write(`${JSON.stringify(frame)}\\n`); }",
    "rl.on('line', (line) => {",
    "  const request = JSON.parse(line);",
    "  if (request.method === 'app/capabilities') {",
    "    send({ type: 'mcp_startup_update', update: { status: 'ready' } });",
    "    send({ jsonrpc: '2.0', id: request.id, result: { ok: true, data: { transport: 'stdio+http' }, events: [] } });",
    "  } else if (request.method === 'thread/error') {",
    "    send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'bad params', data: null } });",
    "  } else if (request.method === 'thread/exit') {",
    "    setTimeout(() => process.exit(7), 10);",
    "  } else if (request.method === 'thread/timeout') {",
    "    // Intentionally never respond.",
    "  } else {",
    "    send({ jsonrpc: '2.0', id: request.id, result: { ok: true, method: request.method, params: request.params || {} } });",
    "  }",
    "});"
  ].join("\n"));
  return scriptPath;
}

test("app server client handles JSON-RPC responses and out-of-band event frames", async (t) => {
  const root = makeTempRoot("dstui-app-server-client");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = writeFakeAppServer(root);
  const client = new AppServerClient({
    command: process.execPath,
    args: [scriptPath],
    cwd: root,
    requestTimeoutMs: 1_000
  });
  t.after(() => client.close());

  const events = [];
  client.on("event", (event) => events.push(event));

  const result = await client.request("app/capabilities", {});

  assert.equal(result.ok, true);
  assert.equal(result.data.transport, "stdio+http");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "mcp_startup_update");
  assert.equal(client.running, true);
});

test("app server client rejects JSON-RPC errors and request timeouts", async (t) => {
  const root = makeTempRoot("dstui-app-server-errors");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = writeFakeAppServer(root);
  const client = new AppServerClient({
    command: process.execPath,
    args: [scriptPath],
    cwd: root,
    requestTimeoutMs: 500
  });
  t.after(() => client.close());

  await assert.rejects(
    () => client.request("thread/error", {}),
    /bad params/
  );
  await assert.rejects(
    () => client.request("thread/timeout", {}),
    /timed out/
  );
});

test("app server client rejects pending requests when the server exits", async (t) => {
  const root = makeTempRoot("dstui-app-server-exit");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scriptPath = writeFakeAppServer(root);
  const client = new AppServerClient({
    command: process.execPath,
    args: [scriptPath],
    cwd: root,
    requestTimeoutMs: 1_000
  });
  t.after(() => client.close());

  await assert.rejects(
    () => client.request("thread/exit", {}),
    /exited/
  );
  assert.equal(client.running, false);
});
