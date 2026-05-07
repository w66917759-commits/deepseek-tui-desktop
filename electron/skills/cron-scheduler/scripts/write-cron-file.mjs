#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CRON_ALIASES = new Set([
  "@reboot",
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly"
]);

const DEFAULT_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
].join(":");

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { env: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected argument: ${token}`);
    }

    const inlineIndex = token.indexOf("=");
    const key = inlineIndex > -1 ? token.slice(2, inlineIndex) : token.slice(2);
    const inlineValue = inlineIndex > -1 ? token.slice(inlineIndex + 1) : "";

    if (key === "help") {
      parsed.help = true;
      continue;
    }

    if (key === "env") {
      const value = inlineIndex > -1 ? inlineValue : argv[index + 1];
      if (!value) fail("--env requires KEY=value");
      if (inlineIndex === -1) index += 1;
      parsed.env.push(value);
      continue;
    }

    const value = inlineIndex > -1 ? inlineValue : argv[index + 1];
    if (!value) fail(`--${key} requires a value`);
    if (inlineIndex === -1) index += 1;
    parsed[key] = value;
  }

  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node write-cron-file.mjs --name NAME --schedule \"0 5 * * *\" --command \"npm run task\" [options]",
    "",
    "Options:",
    "  --cwd PATH            Working directory. Defaults to the current directory.",
    "  --timezone NAME       Timezone label written as CRON_TZ. Defaults to the host timezone.",
    "  --out PATH            Cron file path. Defaults to .deepseek/cron/<name>.cron under cwd.",
    "  --log PATH            Log file path. Defaults to .deepseek/logs/<name>.log under cwd.",
    "  --shell PATH          Shell written to the cron file. Defaults to /bin/sh.",
    "  --path VALUE          PATH written to the cron file.",
    "  --env KEY=value       Extra environment line. May be repeated."
  ].join("\n");
}

function requiredString(args, key) {
  const value = String(args[key] || "").trim();
  if (!value) fail(`--${key} is required`);
  if (/[\r\n]/.test(value)) fail(`--${key} cannot contain newlines`);
  return value;
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "scheduled-task";
}

function validateCronSchedule(schedule) {
  if (CRON_ALIASES.has(schedule)) {
    return;
  }

  const fields = schedule.split(/\s+/);
  if (fields.length !== 5) {
    fail("Cron schedule must be a five-field expression or a supported @alias");
  }

  const fieldPattern = /^[A-Za-z0-9*,/?#L\-\[\]]+$/;
  for (const field of fields) {
    if (!fieldPattern.test(field)) {
      fail(`Invalid cron field: ${field}`);
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapeCronPercent(command) {
  let escaped = "";
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const previous = index > 0 ? command[index - 1] : "";
    escaped += char === "%" && previous !== "\\" ? "\\%" : char;
  }
  return escaped;
}

function formatEnvLine(entry) {
  const separator = entry.indexOf("=");
  if (separator <= 0) {
    fail(`Invalid env value: ${entry}`);
  }

  const key = entry.slice(0, separator).trim();
  const value = entry.slice(separator + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    fail(`Invalid env key: ${key}`);
  }
  if (/[\r\n]/.test(value)) {
    fail(`Env value cannot contain newlines: ${key}`);
  }
  if (/^[A-Za-z0-9_/:.,@%+=-]*$/.test(value)) {
    return `${key}=${value}`;
  }
  return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function resolveUnderCwd(cwd, value, fallback) {
  return path.resolve(cwd, value || fallback);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const name = requiredString(args, "name");
  const schedule = requiredString(args, "schedule");
  const command = requiredString(args, "command");
  validateCronSchedule(schedule);

  const cwd = path.resolve(String(args.cwd || process.cwd()));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    fail(`Working directory does not exist: ${cwd}`);
  }

  const slug = slugify(name);
  const timezone = String(args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC").trim();
  const shellPath = String(args.shell || "/bin/sh").trim();
  const pathValue = String(args.path || DEFAULT_PATH).trim();
  const outPath = resolveUnderCwd(cwd, args.out, `.deepseek/cron/${slug}.cron`);
  const logPath = resolveUnderCwd(cwd, args.log, `.deepseek/logs/${slug}.log`);
  const envLines = args.env.map(formatEnvLine);

  if (!timezone || /[\r\n=]/.test(timezone)) {
    fail("Invalid timezone");
  }
  if (!shellPath || /[\r\n]/.test(shellPath)) {
    fail("Invalid shell path");
  }
  if (!pathValue || /[\r\n]/.test(pathValue)) {
    fail("Invalid PATH value");
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const cronLine = [
    schedule,
    "cd",
    shellQuote(cwd),
    "&&",
    escapeCronPercent(command),
    ">>",
    shellQuote(logPath),
    "2>&1"
  ].join(" ");

  const lines = [
    "# Generated by DeepSeek TUI Desktop Cron Scheduler.",
    `# Task: ${name}`,
    `# Created: ${new Date().toISOString()}`,
    "# Review before installing. `crontab <file>` replaces the current user crontab.",
    "# Prefer merging with `crontab -l` when existing entries are present.",
    "# CRON_TZ is included for cron daemons that support it; otherwise the host timezone is used.",
    "",
    `SHELL=${shellPath}`,
    `PATH=${pathValue}`,
    `CRON_TZ=${timezone}`,
    ...envLines,
    "",
    cronLine,
    ""
  ];

  fs.writeFileSync(outPath, lines.join(os.EOL));

  console.log(JSON.stringify({
    ok: true,
    path: outPath,
    schedule,
    command,
    cwd,
    timezone,
    logPath
  }, null, 2));
}

main();
