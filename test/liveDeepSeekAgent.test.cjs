const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DeepSeekDesktopHarness, defaultSettings } = require("../electron/harness.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const LIVE_TEST_ENABLED = process.env.DEEPSEEK_LIVE_TEST === "1";
const LIVE_BRANCH = "agent/live-e2e";
const LIVE_COMMIT_MESSAGE = "test: live DeepSeek desktop workflow";
const DAILY_CRON_NAME = "daily-deepseek-test";
const DAILY_CRON_SCHEDULE = "30 9 * * *";
const LIVE_SKILL_TOKEN = "LIVE_SKILL_DOWNLOAD_TOKEN_5e04d17d";
const SERVED_SKILL = [
  "---",
  "name: live-downloaded-skill",
  "description: Test-only skill served over HTTP for the live DeepSeek desktop workflow.",
  "---",
  "",
  "# Live Downloaded Skill",
  "",
  "This skill proves the agent can download a Skill file during a desktop chat run.",
  "",
  `Token: ${LIVE_SKILL_TOKEN}`
].join("\n");

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function fakeApp(userDataPath, appPath) {
  return {
    isPackaged: false,
    getAppPath() {
      return appPath;
    },
    getPath(name) {
      if (name === "userData") return userDataPath;
      return path.join(userDataPath, name);
    }
  };
}

function parseEnvFile(filePath) {
  try {
    const result = {};
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[match[1]] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function loadDeepSeekApiKey() {
  const localEnv = {
    ...parseEnvFile(path.join(PROJECT_ROOT, ".env")),
    ...parseEnvFile(path.join(PROJECT_ROOT, ".env.local")),
    ...process.env
  };
  const envKey = String(localEnv.DEEPSEEK_API_KEY || "").trim();
  if (envKey) return envKey;

  const storePath = process.env.DEEPSEEK_TUI_DESKTOP_SECRET_STORE
    || path.join(os.homedir(), "Library", "Application Support", "deepseek-tui-desktop", "secrets.json");
  try {
    const secrets = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return String(secrets?.apiKeys?.deepseek || "").trim();
  } catch {
    return "";
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 120000,
    windowsHide: true
  });
  return result;
}

function requireRun(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`
  );
  return result;
}

function sanitizeOutput(value, apiKey) {
  return String(value || "")
    .replaceAll(apiKey, "[REDACTED_DEEPSEEK_API_KEY]")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function failureOutput(result, apiKey) {
  return sanitizeOutput([result.stdout, result.stderr].filter(Boolean).join("\n"), apiKey)
    .split(/\r?\n/)
    .slice(-140)
    .join("\n");
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeout || 120000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        status: 1,
        signal: "",
        stdout,
        stderr: [stderr, error.message].filter(Boolean).join("\n"),
        timedOut
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

function writeInitialRepo(workspacePath, originPath) {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(originPath, { recursive: true });
  requireRun("git", ["init", "--bare"], { cwd: originPath });
  requireRun("git", ["init", "-b", "main"], { cwd: workspacePath });
  requireRun("git", ["config", "user.name", "DeepSeek Live Test"], { cwd: workspacePath });
  requireRun("git", ["config", "user.email", "deepseek-live-test@example.invalid"], { cwd: workspacePath });
  fs.writeFileSync(path.join(workspacePath, "README.md"), "# DeepSeek live desktop test\n");
  requireRun("git", ["add", "README.md"], { cwd: workspacePath });
  requireRun("git", ["commit", "-m", "chore: seed live test workspace"], { cwd: workspacePath });
  requireRun("git", ["remote", "add", "origin", originPath], { cwd: workspacePath });
  requireRun("git", ["push", "-u", "origin", "main"], { cwd: workspacePath });
}

function startSkillServer(t) {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== "/live-downloaded-skill/SKILL.md") {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    requestCount += 1;
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(SERVED_SKILL);
  });

  t.after(() => {
    server.close();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/live-downloaded-skill/SKILL.md`,
        getRequestCount() {
          return requestCount;
        }
      });
    });
  });
}

test("live DeepSeek desktop chat can create a daily task, switch branch, commit, push, and download a Skill", {
  skip: LIVE_TEST_ENABLED ? false : "Set DEEPSEEK_LIVE_TEST=1 to run the live DeepSeek API workflow."
}, async (t) => {
  const apiKey = loadDeepSeekApiKey();
  assert.ok(apiKey, "DEEPSEEK_API_KEY is required in .env, .env.local, the environment, or the desktop secret store.");

  const root = makeTempRoot("dstui-live-agent");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, "userData");
  const workspacePath = path.join(root, "workspace");
  const originPath = path.join(root, "origin.git");
  const skillServer = await startSkillServer(t);
  writeInitialRepo(workspacePath, originPath);

  const harness = new DeepSeekDesktopHarness(fakeApp(userData, PROJECT_ROOT));
  harness.writeSettings({
    ...defaultSettings(),
    workspacePath,
    binaryMode: "custom",
    customBinaryPath: path.join(
      PROJECT_ROOT,
      "node_modules",
      "deepseek-tui",
      "bin",
      "downloads",
      process.platform === "win32" ? "deepseek.exe" : "deepseek"
    ),
    provider: "deepseek",
    model: process.env.DEEPSEEK_LIVE_MODEL || "deepseek-v4-flash",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    skillsEnabled: true,
    mcpEnabled: false,
    enabledMcpServers: [],
    allowShell: true,
    maxSubagents: 1,
    harnessEnabled: true,
    launchAction: "exec"
  });
  harness.saveApiKey({ provider: "deepseek", apiKey });

  const agentPrompt = [
    "You are running from DeepSeek TUI Desktop's chat composer in a temporary integration-test workspace.",
    "Treat the existing origin remote as the safe test GitHub remote for this run.",
    "Do not ask questions and do not modify files outside the current workspace.",
    "",
    "Complete these exact actions:",
    `1. Create and switch to branch ${LIVE_BRANCH}.`,
    `2. Use the cron-scheduler helper at "$DEEPSEEK_SKILLS_DIR/cron-scheduler/scripts/write-cron-file.mjs" to generate .deepseek/cron/${DAILY_CRON_NAME}.cron with name "${DAILY_CRON_NAME}", schedule "${DAILY_CRON_SCHEDULE}", command "npm test", cwd "$PWD", and timezone "Asia/Shanghai".`,
    `3. Download ${skillServer.url} and save the HTTP response exactly as .deepseek/skills/live-downloaded-skill/SKILL.md. Do not synthesize this file. Prefer: mkdir -p .deepseek/skills/live-downloaded-skill && curl -fsSL "${skillServer.url}" -o .deepseek/skills/live-downloaded-skill/SKILL.md`,
    "4. Create docs/live-agent-workflow.md summarizing the branch, daily task, skill download URL, and commit.",
    `5. Run git add -A, commit with message "${LIVE_COMMIT_MESSAGE}", and push the branch to origin with upstream tracking.`,
    "6. Print LIVE_DEEPSEEK_DESKTOP_E2E_DONE after verifying the files and git push."
  ].join("\n");

  const plan = harness.buildLaunchPlan({
    workspacePath,
    launchAction: "exec",
    agentPrompt,
    cols: 120,
    rows: 34
  });

  assert.equal(plan.args[0], "exec");
  assert.ok(plan.args.includes("--auto"));
  assert.ok(plan.args.includes(agentPrompt));
  assert.equal(plan.cwd, workspacePath);
  assert.ok(plan.env.DEEPSEEK_API_KEY, "launch plan should inject the saved DeepSeek API key");
  assert.equal(plan.env.DEEPSEEK_ALLOW_SHELL, "1");
  assert.equal(plan.env.DEEPSEEK_DESKTOP_HARNESS, "1");
  assert.equal(plan.env.DEEPSEEK_DESKTOP_ENABLED_SKILLS, "superpowers,ui-ux-design,cron-scheduler,skill-downloader");
  assert.ok(fs.existsSync(path.join(plan.env.DEEPSEEK_SKILLS_DIR, "cron-scheduler", "scripts", "write-cron-file.mjs")));
  assert.ok(fs.existsSync(path.join(plan.env.DEEPSEEK_SKILLS_DIR, "skill-downloader", "SKILL.md")));

  const result = await runAsync(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    timeout: Number(process.env.DEEPSEEK_LIVE_TIMEOUT_MS || 600000)
  });
  const output = failureOutput(result, apiKey);
  assert.equal(result.status, 0, output);

  const cronPath = path.join(workspacePath, ".deepseek", "cron", `${DAILY_CRON_NAME}.cron`);
  const skillPath = path.join(workspacePath, ".deepseek", "skills", "live-downloaded-skill", "SKILL.md");
  const workflowPath = path.join(workspacePath, "docs", "live-agent-workflow.md");

  assert.equal(fs.existsSync(cronPath), true, "agent should create the daily cron file");
  const cronText = fs.readFileSync(cronPath, "utf8");
  assert.match(cronText, /30 9 \* \* \*/);
  assert.match(cronText, /CRON_TZ=Asia\/Shanghai|CRON_TZ="Asia\/Shanghai"/);
  assert.match(cronText, /npm test/);

  assert.ok(skillServer.getRequestCount() > 0, "agent should request the Skill over HTTP");
  const downloadedSkill = fs.readFileSync(skillPath, "utf8");
  assert.match(downloadedSkill, /name: live-downloaded-skill/);
  assert.match(downloadedSkill, new RegExp(LIVE_SKILL_TOKEN));
  assert.match(fs.readFileSync(workflowPath, "utf8"), /daily|cron|skill|branch/i);

  assert.equal(requireRun("git", ["branch", "--show-current"], { cwd: workspacePath }).stdout.trim(), LIVE_BRANCH);
  const commitSubjects = requireRun("git", ["log", "--pretty=%s", "-5"], { cwd: workspacePath }).stdout;
  assert.match(commitSubjects, new RegExp(LIVE_COMMIT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const remoteBranch = requireRun("git", ["ls-remote", "--heads", "origin", LIVE_BRANCH], { cwd: workspacePath }).stdout;
  assert.match(remoteBranch, new RegExp(`refs/heads/${LIVE_BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});
