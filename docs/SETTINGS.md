# Axel Configuration Reference

This document covers all configuration available to Axel: environment variables loaded at startup and the in-app settings API that can be updated while the server is running. It applies to both supported install paths — a source build (`git clone https://github.com/jhenley1219/axel.git`, then `pnpm install && pnpm build && pnpm start`) and Docker (`docker compose -f docker-compose.public.yml up -d --build`).

---

## Environment Variables

These are read at process startup from the environment (or `.env` file). Changing them requires a server (or container) restart.

### Required in production

| Variable | Type | Description |
|---|---|---|
| `SESSION_SECRET` | string | Secret used to sign session cookies (HMAC-SHA256). Must be at least 32 characters of hex/base64. Generate with `openssl rand -hex 32`. When `NODE_ENV=production`: the server refuses to start if this is the dev default, shorter than 32 chars, or has invalid characters. In dev: a warning is printed but the server still boots with an insecure default. |

### Mode & auth

| Variable | Type | Default | Description |
|---|---|---|---|
| `NODE_ENV` | string | — | Set to `production` to enable production safety checks. In production the server refuses to start with an insecure `SESSION_SECRET`, and authentication is forced on (see `REQUIRE_AUTH`). |
| `REQUIRE_AUTH` | boolean | `false` (local) / forced on in production | When `true` — or whenever `NODE_ENV=production` — every request requires a valid session. Leave unset for an open local-dev session. |
| `WORKSPACE_ROOT` | string | — | Optional single root. When set, unset path vars (`PROJECTS_DIR`, `CREDENTIALS_PATH`, `AUDIT_LOG_PATH`, `MCP_REGISTRY_DIR`) derive from it instead of their individual defaults. |

### Filesystem

| Variable | Type | Default | Description |
|---|---|---|---|
| `PROJECTS_DIR` | string | `<WORKSPACE_ROOT>/projects`, else `/projects` | Working directory for agent invocations — the common parent of all project directories. If `WORKSPACE_ROOT` is set it resolves to `<WORKSPACE_ROOT>/projects`; otherwise it falls back to `/projects` (the Docker volume `axel-projects` is mounted there). For a local source build, set this explicitly to the folder that holds your projects. |
| `ALLOWED_DIRS` | string | derives from `PROJECTS_DIR` | Colon-separated list of absolute paths the agent may read and write. The `PermissionGuard` rejects any file access outside this list. Example: `/projects:/home/axel/notes`. Defaults to `[PROJECTS_DIR]` if not set. |
| `CREDENTIALS_PATH` | string | `<WORKSPACE_ROOT>/data/credentials.json`, else `./data/credentials.json` | Path to the stored username/password hash file. Written with mode `0o600`. |
| `AUDIT_LOG_PATH` | string | `<WORKSPACE_ROOT>/data/audit/commands.jsonl`, else `./data/audit/commands.jsonl` | Path to the append-only JSONL audit log. Never truncated by the application. Written with `flags: 'a'`. |
| `SETTINGS_PATH` | string | `<dirname(AUDIT_LOG_PATH)>/../settings.json` | Path to the persisted in-app settings JSON (see [In-App Settings API](#in-app-settings-api)). Written with mode `0o600`. |
| `MCP_REGISTRY_DIR` | string | `<WORKSPACE_ROOT>/.axel/mcp-registry`, else `~/.axel/mcp-registry` | Directory containing MCP registration JSON files. Axel reads all `.json` files in this directory on every agent invocation — no restart needed when you add or remove a file. |
| `PYTHON_SCRIPT_DIR` | string | auto-detected bundled `python/` dir | Override for the directory holding the bundled Python TTS scripts. Auto-located across repo / Docker layouts; rarely needs setting. |

### Server

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | number | `8080` | HTTP port for the Express server. The server binds `0.0.0.0`, so it is reachable on your LAN by design (e.g. so a phone on the same network can connect) — it is **not** localhost-only. |
| `ALLOWED_ORIGINS` | string | — | Comma-separated list of additional CORS origins to allow. Localhost origins are always allowed. |

> **Network safety.** Because the server listens on `0.0.0.0`, place Axel on a private network (e.g. [Tailscale](https://tailscale.com/)) and never expose it directly to the public internet.

### TTS

| Variable | Type | Default | Description |
|---|---|---|---|
| `PYTHON_PATH` | string | `python3` | Path to the Python 3 interpreter. Used by the server-side TTS engines (Piper, Kokoro). |

### Git / GitHub

| Variable | Type | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | string | — | GitHub fine-grained Personal Access Token. Written to `.git-credentials` inside the container so `git push` and `gh` CLI commands authenticate without interactive prompts. Grant only the repository permissions you need. |
| `GIT_USER_NAME` | string | `axel` | Git commit author name. Written to `/home/axel/.gitconfig` by the container entrypoint. |
| `GIT_USER_EMAIL` | string | `axel@localhost` | Git commit author email. Written to `/home/axel/.gitconfig` by the container entrypoint. |

### Agent runtime credentials

These apply to both agent runtimes (see [Agent runtimes](#agent-runtimes)). `agentRuntime: 'claude-code'` (the default) wraps the installed `claude` CLI; `agentRuntime: 'axel'` is the in-tree multi-provider runtime.

| Variable | Type | Default | Description |
|---|---|---|---|
| `CLAUDE_PATH` | string | auto-detected `claude` on PATH | Absolute path to the `claude` binary used by the `claude-code` runtime. Auto-located at `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, or via `command -v claude`. The Docker image installs it at `/usr/local/bin/claude`. |
| `ANTHROPIC_API_KEY` | string | — | Anthropic API key. Used as a fallback when no key is set via the in-app settings (`apiKeys.anthropic`). Passed into the spawned agent's environment. |
| `ANTHROPIC_BASE_URL` | string | — | Override the Anthropic API base URL (e.g. for a proxy or gateway). Passed into the spawned agent's environment. |

---

## In-App Settings API

Stored as JSON at `<dirname(AUDIT_LOG_PATH)>/../settings.json` (override with `SETTINGS_PATH`). Persists across restarts; the file is written with mode `0o600`.

### Endpoints

```
GET  /api/settings      Returns settings (with apiKeys stripped) + hasKeys flags + projectsRoot + mcpRegistryDir
PUT  /api/settings      Merges the request body into the current settings
```

Both endpoints require a valid session cookie.

### Response shape (GET)

```ts
{
  ok: true,
  settings: AppSettings,                  // apiKeys field is omitted entirely
  hasKeys: Record<string, boolean>,       // e.g. { anthropic: true } — never the keys themselves
  projectsRoot: string | null,            // resolved working directory
  mcpRegistryDir: string                  // resolved MCP registry directory
}
```

**Keys never leave the server.** `getRedactedSettings` deletes `apiKeys` from the response entirely — only the `hasKeys` boolean map is returned so the UI can show "key set / not set" without seeing the value.

### Agent runtimes

Axel ships **two** agent runtimes, selected by the `agentRuntime` setting:

- **`claude-code`** (default, most polished) — wraps your installed `claude` CLI. The root agent spawns it non-interactively via `claude -p --output-format stream-json` (`ClaudeCodeAgent`); child / project terminals run an interactive `claude` `node-pty` session (`PtyAgent`).
- **`axel`** — the in-tree, multi-provider runtime. It runs its own tool loop with **no external binary**, backed by a provider factory for Anthropic / OpenAI / local Ollama, plus a `modelTier` that nudges prompting for the model's capability. Open and local-model support is supported today and is actively being improved.

### AppSettings schema

| Field | Type | Default | Description |
|---|---|---|---|
| `ttsVoice` | `'ava' \| 'andrew'` | `'ava'` | Voice preference. Maps per engine: Piper `en_US-amy-medium` / `en_US-ryan-medium`, Kokoro `af_heart` / `am_michael`, browser → name preference. |
| `agentRuntime` | `'claude-code' \| 'axel'` | `'claude-code'` | Which runtime backs the agent. `claude-code` wraps the installed `claude` CLI; `axel` is the in-tree multi-provider runtime (no external binary). Resolved per-call, so changing it takes effect on the next message. |
| `runtimeProvider` | `'anthropic' \| 'openai' \| 'ollama'` | `'anthropic'` | Provider used by the `axel` runtime. Its API key (if any) is read from `apiKeys[runtimeProvider]`. |
| `runtimeModel` | string | — | Model ID for the `axel` runtime (provider-specific, e.g. an Anthropic, OpenAI, or Ollama model name). |
| `runtimeBaseURL` | string | — | Base URL override for the `axel` runtime's provider (e.g. a local Ollama endpoint or an OpenAI-compatible gateway). |
| `modelTier` | `'frontier' \| 'mid' \| 'q4-local' \| 'q2-local'` | — | Capability tier hint for the `axel` runtime. Adjusts prompting and permission policy for smaller / quantized local models (more guardrails the lower the tier). |
| `apiKeys` | `Record<string, string>` | `{}` | Provider keys keyed by provider id (e.g. `{ anthropic: 'sk-ant-...' }`). Merged on PUT; set a key to `""` or `null` to delete it. **Stripped from every GET response** — only `hasKeys` booleans are returned. |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions'` | `'default'` | Per-spawn permission mode. `default` routes every write/command through the in-app allow/deny prompt (`PermissionBroker`); `acceptEdits` auto-approves edits; `bypassPermissions` skips prompts entirely. |
| `effortLevel` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | — | Reasoning effort passed to the model. PUT `""` to clear. |
| `projectsRoot` | string | — | Override for the agent's working directory. Falls back to the `PROJECTS_DIR` env / CLI `--root` value. PUT `""` to clear. The projects watcher restarts when this changes. |
| `modelProvider` | `'claude-code' \| 'anthropic-api' \| 'openai' \| 'custom'` | — | **Legacy.** Retained for backward compatibility but **not** used for runtime selection — use `agentRuntime` / `runtimeProvider` instead. |
| `modelId` | string | — | **Legacy.** Paired with the legacy `modelProvider`; not used by either runtime. Use `runtimeModel`. |
| `customEndpoint` | string | — | **Legacy.** Paired with the legacy `modelProvider: 'custom'`; not used by either runtime. Use `runtimeBaseURL`. |

### Example: change the TTS voice

```bash
curl -X PUT http://localhost:8080/api/settings \
  -H 'Content-Type: application/json' \
  -b 'session=<your-session-cookie>' \
  -d '{ "ttsVoice": "andrew" }'
```

---

## Built-In Constants

These values are compiled into the application. They can only be changed by modifying the source in `packages/core/src/constants/limits.ts` and rebuilding.

| Constant | Value | Description |
|---|---|---|
| `MAX_USER_MESSAGE_BYTES` | 262144 (256 KB) | Maximum size of a single user message sent to the agent over WebSocket. |
| `AUTH_MAX_ATTEMPTS` | 3 | Number of failed login attempts before an IP is locked out. |
| `AUTH_LOCKOUT_MS` | 300000 (5 min) | Duration of the hard lockout after `AUTH_MAX_ATTEMPTS` failures. |
| `SESSION_REMEMBER_MS` | 2592000000 (30 days) | Session token TTL. The auth routes always issue tokens with this lifetime — this is the effective token TTL. |
| `SESSION_TTL_MS` | 14400000 (4 h) | Default `ttlMs` argument of `SessionManager.issue()`. **Effectively unused** — the auth routes always pass `SESSION_REMEMBER_MS`, so no 4 h token is ever issued. |
| `CHAT_RECORDING_MAX_MS` | 20000 (20 s) | Maximum duration the browser records a single voice input before auto-stopping. Speech-to-text runs **in the browser** — audio is never uploaded to the server. |
| `AUTH_RECORDING_MAX_MS` | 6000 (6 s) | Maximum recording duration on the lock screen (browser-side, like the above). |
| `AUDIO_MAX_BYTES` | 52428800 (50 MB) | **Unused legacy constant.** There is no server-side STT endpoint or audio upload — speech-to-text is browser-only. |

---

## MCP Registry Format

> **Canonical reference:** [MCP_REGISTRATION.md](../MCP_REGISTRATION.md) is the source of truth for MCP registration, including how to secure your MCP server. The summary below is a quick reference only.

Axel reads all `.json` files from `MCP_REGISTRY_DIR` (`~/.axel/mcp-registry/` by default) on every agent invocation. Changes take effect on the next message — no restart needed.

### HTTP transport (most common)

```json
{
  "name": "myapp",
  "url": "http://127.0.0.1:9003/mcp",
  "token": "your-32-char-random-bearer-token",
  "description": "My app — manages widgets and reports",
  "addDir": "/projects/myapp"
}
```

### Stdio transport

```json
{
  "name": "myapp",
  "kind": "stdio",
  "command": "/usr/local/bin/myapp-mcp",
  "args": ["--config", "/etc/myapp/mcp.json"],
  "env": { "MY_VAR": "value" },
  "description": "My app via stdio MCP"
}
```

### Field reference

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique slug. Claude sees tools as `mcp__<name>__<toolname>`. |
| `url` | yes (HTTP) | MCP endpoint URL. Must be `http://127.0.0.1:PORT/mcp`. |
| `command` | yes (stdio) | Binary to spawn. |
| `token` | no | Bearer token sent in `Authorization` header (HTTP only). |
| `description` | no | Shown in the system prompt so the agent knows what the app does. |
| `addDir` | no | Directory added to Claude's `--add-dir` flag, allowing file access for this app. |

See [MCP_REGISTRATION.md](../MCP_REGISTRATION.md) for a full walkthrough including how to secure your MCP server.

---

## PermissionGuard Deny Patterns

The following shell command patterns are blocked by `PermissionGuard` before the agent can execute them (regardless of which runtime is active). These patterns live in `packages/core/src/constants/permissions.ts`.

| Pattern | What it blocks |
|---|---|
| `rm -r` (any flag position) | Recursive file removal |
| `rm --recursive` | Recursive file removal (long form) |
| `rm -f` | Forced file removal |
| `mkfs` | Filesystem formatting |
| `dd if=` | Disk imaging/wiping |
| `chmod 7xx` or `xx7` | World-writable permission changes |
| `chmod +w` for all/other | Global write permission grants |
| `> /dev/*` | Redirect to device nodes |
| `\| sh` or `\| bash` | Pipe to shell (code injection) |
| `:() {` | Fork bomb |
