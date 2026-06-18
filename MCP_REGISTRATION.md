# Connecting an App to Axel via MCP

Every app you build that wants Axel to control it needs to:
1. Expose an MCP server. Either an **HTTP** server on `http://127.0.0.1:PORT/mcp`
   (Streamable HTTP transport, a long-running process the agent connects to), or
   a **stdio** binary the agent spawns per invocation.
2. Drop a registration file into `~/.axel/mcp-registry/`.

Axel re-reads the registry on **every agent message** and passes the live list to the
agent via a freshly generated temp `--mcp-config` file (written with mode `0o600`,
one per spawn). No restart needed — new apps show up on the next message (hot reload).

> Heads up: the Axel server itself binds `0.0.0.0` so a phone on your LAN can reach
> the UI. Your *MCP servers*, however, should bind `127.0.0.1` (loopback) only — they
> are an internal control surface, not something to expose on the network. Run Axel and
> its apps on a private network such as Tailscale and never on the public internet.

---

## Registration file format

**`~/.axel/mcp-registry/<your-app-name>.json`**

### HTTP transport

```json
{
  "name": "mimedia",
  "url": "http://127.0.0.1:9001/mcp",
  "token": "your-32-char-random-bearer-token",
  "description": "MiMedia social video platform — manage posts, feeds, users",
  "addDir": "/path/to/your/project"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique slug. Tools appear as `mcp__<name>__<tool>` to the agent |
| `url` | yes (http) | Should be `http://127.0.0.1:PORT/mcp`. Bind to `127.0.0.1` only |
| `token` | no | Bearer token. Sent to your server as the `Authorization: Bearer <token>` header |
| `description` | no | Shown in Axel's system prompt so the agent knows what the app does |
| `addDir` | no | Directory the agent can read/write files in for this app (becomes `claude --add-dir`) |
| `presentation` | no | Optional bubble-bar display hints (`label`, `icon`, `accent`, `summary`) |

### stdio transport

For tools that run as a spawned binary instead of a long-running server, omit `url`
and provide `command` (plus optional `args` / `env`). Axel detects stdio when an
explicit `transport`/`type` field is set to `"stdio"`, **or** when `command` is present
and `url` is absent.

```json
{
  "name": "myfiletool",
  "command": "/usr/local/bin/my-mcp-server",
  "args": ["--flag"],
  "env": { "MY_TOKEN": "..." },
  "description": "Local stdio MCP tool",
  "addDir": "/path/to/your/project"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique slug. Tools appear as `mcp__<name>__<tool>` to the agent |
| `command` | yes (stdio) | Executable Axel spawns per invocation |
| `args` | no | Argument array passed to `command` |
| `env` | no | Extra environment variables for the spawned process |
| `description` | no | Shown in Axel's system prompt so the agent knows what the app does |
| `addDir` | no | Directory the agent can read/write files in for this app (becomes `claude --add-dir`) |
| `presentation` | no | Optional bubble-bar display hints (`label`, `icon`, `accent`, `summary`) |

---

## Generating a token

```bash
openssl rand -hex 32
```

Store the token in your app's `.env` as `AXEL_MCP_TOKEN` and validate it on
every incoming MCP request.

---

## MCP server requirements (HTTP transport)

- Transport: **Streamable HTTP** (POST + GET to `/mcp`)
- Bind to `127.0.0.1`, not `0.0.0.0`
- Validate `Origin` header on all requests (DNS rebinding protection)
- Validate `Authorization: Bearer <token>` if you set a token
- Respond to `tools/list` with your tool definitions
- Tool names must be unique within your server (they get namespaced automatically)

## Built-in tools

Axel always wires in a set of loopback-only bridge MCPs of its own — you do not
register these, and you should not pick a `name` that collides with them (per-spawn
bridges are applied last, so a registry file can never shadow them). They appear to the
agent as `mcp__<name>__<tool>`, with underscores in the namespace, for example:

- `mcp__axel_permissions__approve` — the permission-prompt bridge
- `mcp__axel_terminals__open_terminal` — open a project terminal
- `mcp__axel_files__open_file` — surface a file to the user

These bridges are bound to `127.0.0.1` (the Axel server's loopback address).

## Quick registration helper

```bash
# Register an app (note: token must be a literal value, not a $(...) expansion —
# generate it first, then paste it in)
TOKEN=$(openssl rand -hex 32)
cat > ~/.axel/mcp-registry/myapp.json << EOF
{
  "name": "myapp",
  "url": "http://127.0.0.1:9003/mcp",
  "token": "$TOKEN",
  "description": "My app description",
  "addDir": "/path/to/your/project"
}
EOF

# Deregister
rm ~/.axel/mcp-registry/myapp.json
```

No Axel restart needed in either case.
