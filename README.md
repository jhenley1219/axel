# Axel

**Axel is a self-hosted, voice-driven AI coding agent.** Talk to your dev environment in plain language — write and edit code, run git, manage projects, trigger deploys, and call tools on any app you connect — and hear the answer back. It runs entirely on your own machine or home server; the only thing that leaves your network is the model API call (and even that can be a local model).

- **Voice-native.** Speak a request, hear a spoken response. The UI is a "constellation" of your projects that the agent moves through as it works.
- **Self-hosted.** Your code, your machine. Reach it from your phone over a private network (e.g. [Tailscale](https://tailscale.com)).
- **Bring your own model.** Claude (via the Claude Code CLI) is the polished default; an in-tree multi-provider runtime also supports OpenAI and local models via [Ollama](https://ollama.com). See [Runtimes & models](#runtimes--models).
- **MCP tool support.** Any app that exposes an [MCP](https://modelcontextprotocol.io) server can give Axel new tools — drop a JSON file in the registry and the tools appear on the next message, no restart.
- **Local voices.** Optional server-side text-to-speech runs fully local (Piper / Kokoro). No cloud TTS, no usage cost.
- **Audit logged.** Every tool call the agent makes is appended to a JSONL audit log.
- **Single-user auth.** One account, Argon2id password hashing, signed session cookies, and a QR flow to pair your phone.

> **Status:** Axel is young and evolving. It is built for a single trusted user on a private network — please read [SECURITY.md](SECURITY.md) before exposing it anywhere.

---

## Requirements

| | |
|---|---|
| **Node.js** | 20 or newer (the Docker image and CI use 22) |
| **pnpm** | 10.x (`npm install -g pnpm`) |
| **Claude Code CLI** | Required for the default runtime. Install with `npm install -g @anthropic-ai/claude-code`, then sign in (see below). Not required if you only use the in-tree `axel` runtime with your own provider key. |
| **Python 3.11+** | Optional — only for higher-quality local voices (Piper / Kokoro). The browser's built-in voice works without it. |
| **Docker** | Optional — only for the container setup. |

You also need a way for the agent to reach a model: either the Claude CLI signed in (you can do this from inside the app), an `ANTHROPIC_API_KEY`, or — for the `axel` runtime — an OpenAI key or a local Ollama server.

---

## Quick start (from source)

This is the recommended way to run Axel today.

```bash
git clone https://github.com/jhenley1219/axel.git
cd axel
pnpm install
pnpm build
pnpm start            # serves on http://localhost:8080 and opens your browser
```

Run against a specific workspace (the parent folder of the projects you want the agent to touch):

```bash
pnpm start -- --root ~/code      # or:  node bin/axel.js --root ~/code --port 9000
```

`--root` sets the workspace; the agent works inside `<root>/projects`. `--port` changes the port (default `8080`).

On first launch:
1. **Sign the agent in to a model.** Open **Settings → Claude** and use the in-app sign-in, or save an API key under **Settings → Model**. (If your `claude` CLI is already logged in, Axel uses that automatically.)
2. **Tap the orb and talk.** That's it.

> A local run does **not** require you to create an Axel account by default. Account/login is enforced only when you set `REQUIRE_AUTH=true` or `NODE_ENV=production` (the Docker setup turns this on) — see [Exposing Axel on your network](#exposing-axel-on-your-network).

---

## Quick start (Docker)

A ready-to-use public image setup ships in the repo. The TTS voice models are baked into the image, so voices work out of the box.

```bash
git clone https://github.com/jhenley1219/axel.git
cd axel
docker compose -f docker-compose.public.yml up -d --build   # builds, then serves on :8080
```

This mounts your home directory into the container so the Browse button can reach your real files, and turns on auth (`REQUIRE_AUTH=true`) — you'll create an account on first load. Sign the agent in to Claude from **Settings → Claude**; the login persists on a Docker volume.

**Isolated single-project mode** (mounts only one project directory you pick, and auto-detects its stack):

```bash
node bin/axel-docker-init.js
```

It generates `Dockerfile.user.generated` + `docker-compose.user.yml` and brings the container up. Stop everything with `docker compose -f docker-compose.public.yml down`.

---

## Voice (text-to-speech)

The browser's built-in Web Speech API works with **no setup**. For higher-quality, fully-local voices, install the Python TTS engines and download the models (the Docker image already includes these):

```bash
pip3 install -r python/requirements.txt        # or: pnpm install:python
mkdir -p python/models/piper python/models/kokoro

# Piper voices (~120 MB)
python3 -m piper.download_voices en_US-amy-medium en_US-ryan-medium --data-dir python/models/piper

# Kokoro-82M (~340 MB)
curl -L -o python/models/kokoro/kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o python/models/kokoro/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Then choose Piper or Kokoro under **Settings → Voice**. Speech-to-text is handled by your browser (`webkitSpeechRecognition`), so a Chromium-based browser is recommended.

---

## Runtimes & models

Axel can drive the agent two ways. You switch between them under **Settings**.

**`claude-code` (default, recommended).** Wraps your installed `claude` CLI. The root agent streams responses for voice; project sub-terminals run an interactive `claude` session you can watch in an xterm view. This is the most polished path.

**`axel` (in-tree, multi-provider).** A built-in agent tool loop with no external binary, backed by a pluggable provider — **Anthropic**, **OpenAI**, or a local **Ollama** model. This is how you run Axel against open / local models. It also carries a "model tier" notion (`frontier` / `mid` / `q4-local` / `q2-local`) that tightens confirmation and structure for weaker local models. The open-model harness is supported and **under active development** — expect it to keep improving.

See [docs/architecture.md](docs/architecture.md) for how the runtimes are wired.

---

## Configuration

Everything has a sensible default for local use — you only need to set variables to override a default. `.env.example` is the template. Where you put the values depends on how you run Axel:

- **`pnpm dev`** loads `apps/server/.env` — `cp .env.example apps/server/.env` and edit it.
- **`pnpm start` / production** reads variables from the process environment — export them in your shell (or set them in your service manager).
- **Docker** — set them in `docker-compose.public.yml` (it already passes `REQUIRE_AUTH` through).

Most-used variables (full reference in [docs/SETTINGS.md](docs/SETTINGS.md)):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP/HTTPS port (or use `--port`). |
| `WORKSPACE_ROOT` | cwd (via the CLI) | Workspace root; `PROJECTS_DIR`, data paths, and the MCP registry derive from it. |
| `PROJECTS_DIR` | `<WORKSPACE_ROOT>/projects` | Parent of your project dirs; the agent's working directory. |
| `ALLOWED_DIRS` | = `PROJECTS_DIR` | Colon-separated paths the agent may read/write. Everything else is denied. |
| `REQUIRE_AUTH` | `false` (`true` in prod/Docker) | Force the login/account screen. |
| `NODE_ENV` | — | `production` forces auth on, enforces `SESSION_SECRET`, and disables the dev cert. |
| `SESSION_SECRET` | auto-generated | Signs session cookies; set a stable one for server deployments. |
| `ANTHROPIC_API_KEY` | — | Optional; otherwise the Claude CLI login is used. |
| `CLAUDE_PATH` | auto-detected | Path to the `claude` binary if not on `PATH`. |
| `PYTHON_PATH` | `python3` | Interpreter for local TTS. |

In-app settings (model, runtime, provider keys, voice, permission mode) are stored separately and configured from the Settings panel — see [docs/SETTINGS.md](docs/SETTINGS.md).

---

## MCP tool integration

Any app on your machine can give Axel tools by exposing an MCP server and dropping a registration file in `~/.axel/mcp-registry/`. No restart needed — new tools appear on the next agent message. See [MCP_REGISTRATION.md](MCP_REGISTRATION.md) for the format.

---

## Exposing Axel on your network

Axel binds to `0.0.0.0`, so by default it is reachable from other machines on your LAN (this is intentional — it's how you reach it from your phone). It has **no transport encryption of its own** beyond a dev self-signed certificate. For anything beyond localhost, put it behind a private network such as [Tailscale](https://tailscale.com) and set a stable `SESSION_SECRET`. **Do not expose Axel directly to the public internet.** The full threat model is in [SECURITY.md](SECURITY.md).

---

## Project structure

```
apps/server   Express server: WebSockets, REST + MCP routes, service singletons, brokers
apps/web      React + Vite SPA: the voice interface and constellation UI
packages/agent Agent orchestrator, runtimes (ClaudeCode / PTY / in-tree Axel), MCP registry, prompt builder
packages/core  Shared types + execution utilities (audit log, path allowlist, spawn env)
packages/auth  Password hashing, signed sessions, rate limiting
packages/stt   Speech-to-text provider interface (browser STT is used today)
packages/observability Local session recorder + axel-observe MCP server for UI-vs-backend diagnostics
python         Local TTS (Piper / Kokoro) and the Claude OAuth helper
bin            CLI launchers (axel.js, axel-docker-init.js)
```

A full architecture walkthrough with diagrams is in [docs/architecture.md](docs/architecture.md).

---

## Contributing · Security · License

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, project layout, code style, PR checklist.
- [SECURITY.md](SECURITY.md) — threat model and how to report a vulnerability.
- **License:** [MIT](LICENSE). Fork it, build on it, make it yours.
