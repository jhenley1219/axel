# Contributing to Axel

Thank you for your interest in contributing. This document covers how to get the project running locally, the project structure, code style, and the PR process.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20+ | Check with `node --version`. The Docker image and CI use Node 22. |
| pnpm | 10.x | `npm install -g pnpm` |
| Python | 3.11+ | Optional — only needed for server-side TTS (Piper + Kokoro-82M). Without it the browser falls back to the Web Speech API. |
| Docker + Docker Compose | Any recent version | Optional — only needed to test the containerized build locally (see the Docker section below). |
| `claude` CLI | Latest | Optional — `npm install -g @anthropic-ai/claude-code`. Only needed for the default `claude-code` runtime, which wraps this binary. The in-tree `axel` runtime needs no external binary. |

---

## Setup

```bash
# Clone the repo
git clone https://github.com/jhenley1219/axel.git
cd axel

# Install Node dependencies (all packages via pnpm workspaces)
pnpm install

# Install Python dependencies (only needed for server-side TTS)
pip3 install -r python/requirements.txt

# Set up your local env file. Every variable is optional for local dev;
# the dev server reads apps/server/.env (its `dev` script runs
# `node --env-file=.env` from apps/server), so copy the example there:
cp .env.example apps/server/.env
# Edit apps/server/.env if you want to override a default. SESSION_SECRET
# is auto-generated for local use, but you can set a stable one with:
#   SESSION_SECRET=$(openssl rand -hex 32)

# Start the dev servers (Express + Vite in parallel)
pnpm dev
```

The Express server binds `0.0.0.0:8080` and the Vite dev server runs on `http://localhost:5173`, proxying API calls to Express. Open `http://localhost:5173` in your browser. Because the server binds `0.0.0.0`, it is reachable from other devices on your LAN by design (so a phone can connect). Keep it on a private network such as Tailscale and never expose it to the public internet.

### To build and run from source

```bash
pnpm build      # build all packages + the server/web bundles
pnpm start      # run the built server via bin/axel.js
```

> The npm name `axel` is owned by an unrelated third party, so there is no `npx axel` install path for this project. Build from source (above) or use Docker (below).

### Building the Docker image

The public repository ships its own Docker setup: `Dockerfile.public`, `docker-compose.public.yml`, and `docker-entrypoint.public.sh`. Build and run it with:

```bash
docker compose -f docker-compose.public.yml up -d --build
```

This builds the full multi-stage image (Node build → runtime with Python and the `claude` CLI pre-installed) and starts the server on port 8080. The compose file sets `REQUIRE_AUTH=true`, so you log in on first run.

---

## Project Structure

```
axel/
├── packages/           # Shared library packages (@axel/*)
│   ├── core/           # Shared types, constants, PermissionGuard, AuditLogger
│   ├── agent/          # AgentOrchestrator, AgentRuntime, ClaudeCodeAgent, PtyAgent, AxelAgent + providers/ + tools/, McpRegistry, PromptBuilder, brokers
│   ├── auth/           # PasscodeService (Argon2id), SessionManager, RateLimiter
│   └── stt/            # STTProvider interface (server-side speech-to-text)
├── apps/
│   ├── server/         # Express API server + WebSocket agent endpoint
│   └── web/            # Vite + React frontend
├── python/             # Local TTS subprocess scripts (Piper + Kokoro-82M, no cloud APIs)
└── docs/               # Architecture, configuration, and voice-pipeline reference
```

### Package responsibilities

**`@axel/core`** — the base layer. Shared TypeScript types (`AgentWireMessage`, `AppSettings`), constants (`AUTH_MAX_ATTEMPTS`, `SESSION_REMEMBER_MS`, `DENIED_PATTERNS`), and the execution layer (`PermissionGuard`, `AuditLogger`, `ToolExecutor`, `isPathUnder`, `spawnEnv`). Depends on nothing else in the monorepo.

**`@axel/auth`** — authentication primitives. `PasscodeService` (Argon2id hashing and verification), `SessionManager` (HMAC-SHA256 signed token issuance and verification), `RateLimiter` (in-memory per-IP failure counter with a hard lockout — 3 attempts, then a 5-minute lockout). Depends on `@axel/core`.

**`@axel/stt`** — defines the `STTProvider` interface for server-side speech-to-text. Currently scaffolded only: voice input runs in-browser via `webkitSpeechRecognition` (`useSpeechRecognition` hook), so no concrete `STTProvider` is wired up server-side. The package exists for future browsers that lack Web Speech API.

**`@axel/agent`** — the agent stack. `AgentOrchestrator` is the entry point from the server: it builds the system prompt via `PromptBuilder`, reads MCP registrations via `McpRegistry`, and stays runtime-agnostic by resolving an `AgentRuntime` per call. There are **two** runtimes behind that interface:

- **`claude-code`** (default, most polished) wraps the installed `claude` CLI. The root agent runs via `ClaudeCodeAgent`, which spawns `claude -p <message> --output-format stream-json` as a subprocess; child/project terminals run via `PtyAgent`, an interactive `claude` session over a `node-pty` pty.
- **`axel`** (in-tree, multi-provider) runs its own tool loop with **no external binary**. `AxelAgent` drives a `Conversation` through `tools/` (bash, file, UI tools) against a provider chosen by `providers/factory.ts` — Anthropic, OpenAI, or local Ollama — selected by a `modelTier` (`frontier` | `mid` | `q4-local` | `q2-local`) that adapts the prompt. Open and local-model support is supported and actively being improved.

Roughly nine brokers bridge a spawned runtime back to the browser: `PermissionBroker` (allow/deny prompts), `AskBroker` (root-only voice questions), `RequestQueue`/queue broker (child→root escalation), `TerminalBroker` (open terminal tabs), `TerminalReadBroker` (root reads a terminal's output), `FileOpenBroker` (open files in the UI), `CleanupBroker` (close idle dirs), `ReportBroker` (child end-of-turn reports), and `AppBroker` (shared in-process apps like timer/notes). Per-target `listProjects` powers the directory matcher used for fan-out routing.

**`apps/server`** — Express server. Mounts routers for: health (`/healthz`), auth (account setup, login, logout, status), claude CLI OAuth, TTS synthesis, LAN/network info, and the per-spawn MCP broker bridges (`/mcp/permission/:spawnId`, `/mcp/terminal/:spawnId`, `/mcp/files/:spawnId`, `/mcp/apps`, `/mcp/cleanup/:spawnId`, `/mcp/ask/:spawnId`, `/mcp/queue/:spawnId`, `/mcp/report/:spawnId`, terminal-read). The agent endpoints are `/agent/stream` (WebSocket) and `/agent/pty/*` (interactive terminal). Middleware: `requestLogger`, `sessionGuard`. A factory (`services.ts`) constructs the selected `AgentRuntime` (`ClaudeCodeAgent`, `PtyAgent`, or `AxelAgent`) per turn and wires its brokers; other services include `SettingsManager`, `ClaudeAuthService`, `McpRegistry`, and the auth primitives. Depends on all packages.

**`apps/web`** — React + Vite frontend. Top-level component tree: `App` → `LockScreen` (when unauthenticated) | `ConstellationView` (main interface). `ConstellationView` composes `ConstellationScene` (the SVG render tree of `StarSystem`, `Window`, `SessionWin`, `ExpandedView`) and the 3D alternate skin `Galaxy3D`. Voice surface is `VoiceOrb`. Key hooks: `useVoiceInterface` (orchestrates the whole voice loop), `useSpeechRecognition` (webkitSpeechRecognition wrapper), `useTtsEngine` (browser + server TTS queueing), `useVoiceAsks` (one-at-a-time voice questions), `useConstellationTree` (projects + file tree), `useSettings`, `useAuth`, `useClaudeAuth`. Standalone — no direct dependency on server packages.

---

## Running Tests

There are currently no automated tests in the repository. Adding tests is a contribution priority, particularly for:

- `PermissionGuard.check()` — the deny-pattern logic and path allowlist enforcement
- `SessionManager.issue()` / `verify()` / `revoke()` — token lifecycle
- `RateLimiter.check()` / `recordFailure()` — lockout behavior
- `McpRegistry.normalize()` — the loose JSON normalization logic

If you are adding a test suite, use Node's built-in `node:test` runner or Vitest (already compatible with the pnpm workspace setup).

---

## Code Style

This project uses TypeScript strict mode throughout. Follow these conventions — they are not enforced by a linter yet but all existing code follows them and PRs should too.

**Formatting**
- Tabs for indentation (not spaces)
- Single quotes for strings
- Semicolons at end of statements
- Trailing commas in multi-line arrays and objects

**TypeScript conventions**
- `type` not `interface`
- `Array<T>` not `T[]`
- Arrow function expressions assigned to `const`, not `function` declarations — except class methods and top-level route handlers that need hoisting
- Explicit return type annotations on exported functions and class methods
- `unknown` not `any` for untyped inputs; narrow with type guards before use

**Imports**
- ESM `import` only (the project uses `"type": "module"` throughout)
- Within a package, use relative imports with `.js` extension (TypeScript resolves them correctly)
- Across packages, use the workspace package name (`@axel/core`, `@axel/agent`, etc.)

**Secrets and sensitive data**
- Never log session tokens, password hashes, or API keys — not even at debug level
- Never commit `.env` files or any file containing real credentials
- If an error message might contain a secret (e.g. a URL with a token), strip it before logging or returning to the client

**Password hashing**
- Always use `PasscodeService` from `@axel/auth` which uses Argon2id (`m=65536, t=3, p=1`)
- Never use MD5, SHA-1, SHA-256, or bcrypt for password storage

---

## Pull Request Checklist

Before opening a PR, confirm all of the following:

- [ ] `pnpm build` completes without TypeScript errors
- [ ] The change does not introduce any new `console.log` calls that may emit sensitive data (credentials, session tokens, file contents, API keys)
- [ ] No hardcoded secrets, tokens, or real credentials appear anywhere in the diff
- [ ] No changes to `.env` or `.env.example` that add secrets (documenting a new env var is fine; setting a default value that is a real secret is not)
- [ ] If the change touches `PermissionGuard`, `SessionManager`, `RateLimiter`, or any auth route — describe the security reasoning in the PR description
- [ ] If the change adds a new npm dependency — explain why it is needed and that no existing package in the repo can do the job
- [ ] If the change adds a Python dependency — add it to `python/requirements.txt`
- [ ] The PR description explains what the change does and why

---

## Commit Messages

Use the imperative mood in the subject line: "Add voice capture hook" not "Added" or "Adding". Keep the subject under 72 characters. Add a body if the change is non-obvious or has caveats.
