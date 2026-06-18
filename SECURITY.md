# Security Policy

## Threat Model

### Local deployment (build from source)

When running locally (built from source via `pnpm start`, or via Docker), the
server binds to `0.0.0.0` and is **reachable on your LAN by design** — this is
intentional so a phone or another device on the same network can connect. The
startup log even prints the LAN URL for that purpose. Axel has no transport
security of its own beyond an optional dev self-signed certificate, so it
relies on the surrounding network being trusted. The threat model is: a single
trusted user on a private network. Filesystem access is scoped to the directory
you run from (or set via `--root`).

Run Axel behind a private network such as Tailscale and **never expose its port
to the public internet.**

### Server deployment

For server deployments, Axel's web port is intended to be reachable **only over a private network** such as Tailscale — a WireGuard-based mesh network. The security model assumes a trusted private network; it is not designed for public internet exposure.

In either deployment:

- There is no multi-tenancy and no public sign-up.
- Secrets (session cookies, API keys) are protected at the transport and storage layer, not by obscurity.
- The agent's blast radius is limited by an explicit filesystem allowlist and a PermissionGuard that blocks destructive shell patterns before execution.

If you are running Axel with its port exposed to the public internet, that is outside the intended deployment and you should apply additional hardening.

---

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities by one of the following methods:

1. **GitHub private security advisory** — Use the "Report a vulnerability" button on the repository's Security tab. This creates a private draft advisory visible only to maintainers.
2. **Email** — Send details to the repository owner via the email listed on their GitHub profile.

### What to include

A useful report includes:

- A description of the vulnerability and the potential impact
- Steps to reproduce the issue (proof-of-concept code or request sequences if applicable)
- The component or file where the issue exists (e.g. `packages/auth/src/SessionManager.ts`, the WebSocket upgrade handler)
- The version or commit hash where the issue was observed
- Any suggested mitigations you have identified

The more specific the report, the faster it can be triaged.

---

## Response Timeline

| Milestone | Target |
|---|---|
| Acknowledge receipt | Within 72 hours |
| Confirm whether it is a valid vulnerability | Within 7 days |
| Publish a patch | Within 30 days of confirmation for high-severity issues |

Timelines may be longer for low-severity issues or issues that require significant architectural changes. You will be kept informed of progress.

---

## Scope

### In scope

- **Session and authentication** — `packages/auth/`, `apps/server/src/routes/auth.ts`, cookie handling, rate limiter
- **Agent tool execution** — `packages/core/src/execution/PermissionGuard.ts`, `AuditLogger.ts`, filesystem path validation
- **WebSocket upgrade** — `apps/server/src/routes/agent.ts`, session validation on WebSocket handshake
- **MCP registry** — `packages/agent/src/McpRegistry.ts`, handling of registered app endpoints, and the loopback `axel_*` bridge routes (`apps/server/src/routes/mcp*.ts`)
- **File access controls** — `ALLOWED_DIRS` enforcement, path traversal in `PermissionGuard.isPathAllowed`
- **TTS/STT subprocess handling** — shell injection vectors in subprocess calls
- **Secrets in logs or responses** — API keys, session tokens, or internal hostnames exposed in error messages or audit log entries

### Out of scope

- The Claude API and claude.ai itself — report those to Anthropic
- MCP servers built by third parties and registered with Axel
- Vulnerabilities that require prior compromise of the Tailscale network or the host machine
- Issues in the hosting platform or reverse proxy you deploy behind
- Denial of service from a user who is already authenticated (single-user tool)

---

## Security Design Notes

These are the key security controls in the current implementation. Understanding them helps contextualize any report.

**Auth rate limiting.** Login and setup endpoints use a per-IP failure counter (`packages/auth/src/RateLimiter.ts`): after 3 failed attempts the IP is locked out for 5 minutes and further requests are rejected with HTTP 429. A successful login clears the counter. The rate limiter is in-memory and resets on restart — this is a known limitation.

**Session cookies.** Session cookies are `HttpOnly`, `Secure`, and `SameSite=Strict`. The session token is HMAC-SHA256 signed with `SESSION_SECRET`. Logout revokes the token server-side via an in-memory revocation set.

**Password hashing.** Argon2id with `m=65536, t=3, p=1`. Never MD5, SHA-1, or bcrypt.

**Filesystem allowlist.** The agent can only read and write paths within `ALLOWED_DIRS`. Paths are resolved via `fs.realpathSync` before comparison to prevent symlink traversal.

**PermissionGuard.** All tool calls from the agent pass through `PermissionGuard.check()` before execution. Destructive shell patterns (e.g. `rm -rf`, pipe-to-shell, device writes) are blocked by a deny list.

**Audit log.** Every tool call — allowed and denied — is written to an append-only JSONL file (`AUDIT_LOG_PATH`). The log file is written with `flags: 'a'` and is never truncated by the application.

**MCP registrations are trusted input.** Registered MCP apps are connected at the `url` (or `command`) recorded in their registry entry **verbatim** — Axel does not validate or restrict that endpoint. Treat the MCP registry as trusted: only register apps you control. The loopback `axel_*` bridges (the built-in `open_file`, `open_terminal`, permission-prompt, queue, etc. routes — **not** the registered third-party apps) are the ones that are hardened: each `apps/server/src/routes/mcp*.ts` route accepts connections only from `127.0.0.1`/`::1` and authorizes the caller with an unguessable per-spawn `spawnId` capability.

**Non-root container.** *(Applies to server/Docker deployments only.)* The runtime container runs as a dedicated `axel` user (non-root). Data directories are owned by this user.
