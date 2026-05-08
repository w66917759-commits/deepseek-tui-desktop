# DeepSeek TUI Desktop

<p align="center">
  <img src="build/icon.svg" width="96" alt="DeepSeek TUI Desktop" />
</p>

<p align="center">
  <strong>Desktop GUI shell for the <a href="https://www.npmjs.com/package/deepseek-tui">deepseek-tui</a> open-source CLI coding agent.</strong>
</p>

<p align="center">
  <a href="#deepseek-model-urls">Models</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#build">Build</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#mobile-bridge-api">Mobile API</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

---

## What This Is

DeepSeek TUI Desktop is an **Electron desktop application** that wraps the open-source [`deepseek-tui`](https://www.npmjs.com/package/deepseek-tui) CLI coding agent. The CLI handles all terminal chat, file tools, shell tools, MCP, skills, sessions, sub-agents, and approval behavior. The desktop app provides a graphical shell around it — a Codex-style conversation UI, managed settings, preset MCP servers, skill management, scheduled tasks, and optional mobile bridge.

The runtime is bundled: `deepseek-tui` downloads the upstream `deepseek` binary during `npm install`, and the desktop harness runs it inside a `node-pty` terminal session. No agent-loop behavior is forked or re-implemented.

```
┌──────────────────────────────────────────────────────┐
│                  Electron Main Process               │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Harness  │  │ Settings │  │ Mobile Remote     │  │
│  │ (PTY)    │  │ (userData)│  │ Bridge (HTTP/SSE) │  │
│  └────┬─────┘  └──────────┘  └───────────────────┘  │
│       │ node-pty                                      │
│       ▼                                              │
│  ┌──────────────┐                                    │
│  │ deepseek CLI │  ← upstream binary (bundled)       │
│  └──────────────┘                                    │
└──────────────────────────────────────────────────────┘
         ▲  IPC (preload bridge)
┌────────┴─────────────────────────────────────────────┐
│                React Renderer                        │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│  │  Chat   │ │  Tools   │ │  Tasks   │ │ Terminal│  │
│  │ Surface │ │ (MCP/    │ │ (Sched.) │ │ Output  │  │
│  │         │ │  Skills) │ │          │ │         │  │
│  └─────────┘ └──────────┘ └──────────┘ └─────────┘  │
└──────────────────────────────────────────────────────┘
```

## Quick Start

```bash
npm install
npm run dev
```

`npm install` triggers the `deepseek-tui` postinstall script which downloads the platform `deepseek` binary into `node_modules/deepseek-tui/bin/downloads/`. The desktop app defaults to this bundled runtime but can also use a system or custom binary.

Open the app, paste your DeepSeek API key, choose a workspace, and start chatting.

## Features

### What the Desktop Adds on Top of the CLI

The CLI is fully functional on its own. The desktop layer adds:

- **Graphical conversation UI** — Codex-style layout with left history sidebar (grouped by project/workspace), right conversation surface, and hidden-on-demand drawers for Skills, MCP, workspace, and runtime settings.
- **Model selection** — Top-level UI switch between DeepSeek V4 Pro, V4 Pro 1M, V4 Flash, and V4 Flash 1M. NVIDIA NIM provider also supported.
- **xterm.js terminal** — The upstream TUI runs inside a real PTY backed by `node-pty`, preserving keyboard control, colors, resizing, and prompts. No terminal emulation shortcuts.
- **Workspace picker** — Mapped to `deepseek --workspace <path>`. Workspace-aware with `rememberWorkspace` persistence.
- **One-click IDE handoff** — Open the current workspace in Cursor or VS Code from the desktop UI. On macOS it opens the installed app directly; on other platforms it uses the `cursor` / `code` command if available.
- **Runtime picker** — Bundled, PATH, or custom `deepseek` binary with version detection.
- **Top-level view switch** — `对话` (chat), `工具` (tools — MCP/Skills management), `定时任务` (scheduled tasks), `终端` (focused terminal output). Each surface has its own purpose without crowding the chat view.
- **Permission modes** — `Plan` (non-mutating analysis), `Agent` (full tool access), `YOLO` (auto-approved). Mirrors the upstream mode names.
- **Environment wiring** — `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_PROVIDER`, `DEEPSEEK_MCP_CONFIG`, `DEEPSEEK_SKILLS_DIR`, `DEEPSEEK_ALLOW_SHELL`, `DEEPSEEK_MAX_SUBAGENTS`.

### Skills Management

- Preset Skills: Superpowers (planning/decomposition/verification), UI/UX Pro Max (design system library with scripts and data), Cron Scheduler (advanced crontab helper), Skill Downloader (curl-based skill installer).
- Users can create new `SKILL.md` workflows or import external skill directories.
- Skills are materialized as directories under Electron `userData/skills` or a custom skills root.
- UI/UX Pro Max is imported as a full directory with its `scripts/` and `data/` support files.

### MCP Presets

17 built-in MCP server presets with guided setup:

| Category | Presets |
|---|---|
| Coding | Filesystem, GitHub, Sentry |
| Browser | Playwright, Puppeteer |
| Data | Postgres, Stripe, Google Maps |
| Knowledge | Context7, Sequential Thinking, Memory, Brave Search |
| Productivity | Slack, Notion, Figma Developer |
| Remote | MCP Remote, Panel / 1Panel |

Each preset includes startup instructions, setup cards, token/OAuth/login links, inline credential forms, command preview, auth/env hints, category filters, npm download badges, and safety labels. Credentials are stored in the desktop app's local secret store, not written into MCP JSON files.

### Scheduled Tasks

Simple daily Agent tasks: prompt, workspace, run time, and enable toggle. The desktop app maintains the local runner and logs while keeping API keys in its local secret store — no secrets in schedule files. An advanced `cron-scheduler` skill is available for users who need full crontab control.

### Mobile Remote Bridge

Optional token-protected HTTP/SSE bridge for viewing desktop task progress from a phone app. Disabled by default.

- `GET /api/v1/status` — desktop session and bridge state
- `POST /api/v1/auth/pair` — phone pairing with temporary six-digit code
- `GET /api/v1/events` — SSE stream for terminal output, session status, exit events, update notices
- `POST /api/v1/session/start` — start a desktop run from phone (when remote control is enabled)
- `POST /api/v1/terminal/input` — write input to the PTY (when remote control is enabled)
- `POST /api/v1/skills/upsert` — submit a generated skill from a phone/voice client
- `POST /api/v1/updates/push` — push update notifications to desktop and connected mobile clients

Full contract in [`docs/mobile-remote-api.md`](docs/mobile-remote-api.md).

## DeepSeek Model URLs

The desktop UI exposes four model choices. DeepSeek's official API model IDs are `deepseek-v4-pro` and `deepseek-v4-flash`. The 1M choices use the same API model ID — the official model table lists 1M as the supported context length for both V4 models.

| UI choice | API model sent to DeepSeek | Official documentation |
|---|---|---|
| DeepSeek V4 Pro | `deepseek-v4-pro` | https://api-docs.deepseek.com/news/news260424#deepseek-v4-pro |
| DeepSeek V4 Pro 1M | `deepseek-v4-pro` | https://api-docs.deepseek.com/quick_start/pricing/#model-details |
| DeepSeek V4 Flash | `deepseek-v4-flash` | https://api-docs.deepseek.com/news/news260424#deepseek-v4-flash |
| DeepSeek V4 Flash 1M | `deepseek-v4-flash` | https://api-docs.deepseek.com/quick_start/pricing/#model-details |

## Build

### macOS DMG

```bash
npm run dist:mac
```

Output in `release/`. macOS builds are debug-signed automatically: if a real signing identity is available, electron-builder passes it through; otherwise the project falls back to ad-hoc signing (`codesign -s -`) for development and smoke testing. This is not a notarized production signature.

Force a specific signing identity:

```bash
DEEPSEEK_TUI_MAC_SIGN_IDENTITY="Developer ID Application: Example (TEAMID)" npm run dist:mac
```

Verify the debug-signed app:

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/DeepSeek TUI Desktop.app"
```

### Windows Installer

```bash
npm run dist:win:test
```

Creates or reuses a local self-signed test certificate at `build/certs/deepseek-tui-desktop-local-test.pfx`, prefetches the Windows x64 `deepseek.exe` and `deepseek-tui.exe`, builds the renderer, and creates a signed NSIS installer:

```
release/DeepSeek TUI Desktop-0.1.0-win-x64-setup.exe
```

The test certificate is not trusted and is ignored by git. Testers should expect Windows SmartScreen warnings. Use a real code-signing certificate for public distribution.

Lower-level commands:

```bash
npm run cert:win:self-signed
npm run prepare:win-runtime
npm run dist:win
```

Override the PFX password:

```bash
DEEPSEEK_TUI_WIN_CERT_PASSWORD="your-local-password" npm run dist:win:test
```

### Cross-Build Notes

Windows packaging runs `scripts/prepare-win-runtime.cjs` before Electron Builder. This matters when building from macOS, because the upstream npm postinstall only downloads the current platform's binary. The preflight script downloads and SHA256-verifies the Windows x64 assets into the expected directory.

## Architecture

The desktop app does **not** fork the agent loop. The upstream CLI handles all runtime behavior — terminal chat, Plan/Agent/YOLO/RLM/Duo modes, file tools, shell tools, MCP, skills, sessions, sub-agents, and approval. The desktop harness is a thin orchestration layer.

- **Renderer** (`src/`) — React + TypeScript. Client only. Renders the conversation UI, project-grouped history sidebar, hidden drawers, and terminal output. Four main views: chat, tools (MCP/Skills), scheduled tasks, terminal.
- **Preload bridge** (`electron/preload.cjs`) — narrow IPC boundary between renderer and main.
- **Main process** (`electron/main.cjs`) — owns windows and dialogs, delegates runtime work to the harness.
- **Harness** (`electron/harness.cjs`) — resolves the `deepseek` binary, normalizes workspace, builds launch plans, applies env policy, starts/stops PTY sessions, emits terminal events.
- **Runtime state** (`electron/runtimeState.cjs`) — structured tracking of active agent runs.
- **Remote bridge** (`electron/remoteBridge.cjs`) — optional HTTP/SSE server for mobile client access.
- **Skills** (`electron/skills/`) — bundled preset skill directories imported at first launch.

Settings are saved under Electron `userData`. API keys and conversation terminal output are **not** persisted to settings or history files.

For detailed architecture notes, see [`docs/architecture.md`](docs/architecture.md).

## Mobile Bridge API

Enable the bridge from the `远程` inspector. It is disabled by default, requires a generated token for every request, and separates read-only progress viewing from remote control.

Desktop admin calls use `Authorization: Bearer <bridge-token>` or `x-deepseek-bridge-token: <bridge-token>`. Paired phone calls use a device token returned by the pairing endpoint.

Full endpoint documentation and phone app flow in [`docs/mobile-remote-api.md`](docs/mobile-remote-api.md).

## Roadmap

1. Store API credentials in macOS Keychain / Windows Credential Manager instead of session-only env fields.
2. Add deeper per-MCP connection tests beyond launch-time preflight for token-based presets.
3. Optionally reconcile local desktop history with upstream `deepseek sessions --json` if upstream exposes stable structured output.
4. Replace local Windows test signing with a real trusted certificate before public release.
5. Add a cloud relay / APNs-FCM layer for phone access outside the same LAN.
6. Split the harness into a standalone local service once the upstream runtime exposes a stable structured API.

## Tech Stack

- **Runtime**: [Node.js](https://nodejs.org/) + [Electron](https://www.electronjs.org/) 33
- **Frontend**: [React](https://react.dev/) 18 + [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vitejs.dev/) 6
- **Terminal**: [xterm.js](https://xtermjs.org/) 5 + [node-pty](https://github.com/tyriar/node-pty)
- **Icons**: [Lucide React](https://lucide.dev/)
- **CLI agent**: [`deepseek-tui`](https://www.npmjs.com/package/deepseek-tui) 0.8
- **Packaging**: [electron-builder](https://www.electron.build/) 25 (macOS DMG, Windows NSIS)

## License

Private. See [`package.json`](package.json) for metadata.
