const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("packaged app excludes runtime secrets and local state", () => {
  const packageJson = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const files = packageJson.build?.files || [];
  const requiredExclusions = [
    "!**/.env",
    "!**/.env.*",
    "!**/secrets.json",
    "!**/settings.json",
    "!**/remote-auth.json",
    "!**/automations.json",
    "!**/history.json",
    "!**/mcp.custom.json",
    "!**/mcp.runtime.json",
    "!**/mcp.presets.json",
    "!**/deepseek.desktop.managed.toml",
    "!**/.deepseek/**"
  ];

  assert.ok(Array.isArray(files));
  for (const pattern of requiredExclusions) {
    assert.ok(files.includes(pattern), `Missing packaging exclusion: ${pattern}`);
  }
});
