# Changelog

All notable changes to Axel are documented here.

## [1.1.1] — 2026-07-11

### Fixed

- **Docker runtime missing `@axel/observability`.** The `Dockerfile.public` build stage replaces hoisted workspace symlinks with real copies before the runtime stage; the new `@axel/observability` package was missing from that list, leaving a dangling symlink in the runtime image and crashing the server at startup with `ERR_MODULE_NOT_FOUND`. Source (non-Docker) installs were unaffected.

## [1.1.0] — 2026-07-10

### Added

- **Full terminal transcript reading.** `read_terminal` now reads a sub-terminal's complete conversation from Claude Code's persisted JSONL transcript (new source kind `full`) instead of scraping the TUI framebuffer — mid-turn, after the PTY dies, and free of rendering noise. Results are capped by the new `AXEL_TERMINAL_READ_MAX_CHARS` (default 80,000 chars); when a terminal exceeds the cap the most recent slice is returned with a truncation marker. Omitting `term` enumerates every open terminal for the target.
- **Terminal reuse.** `open_terminal` reuses a project's existing terminal by default; pass `new: true` to force a fresh tab for parallel work. Claude session ids are pinned at spawn (`--session-id` / `--resume`), so conversations survive PTY restarts.
- **`go_home` tool.** Returns the constellation orb to the projects root without opening a terminal ("go home", "leave this project").
- **Nested project support.** Project discovery now recursively finds real project roots (`.git`, `package.json`, …) inside group folders and surfaces them as relative paths (e.g. `clients/acme-web-app`); `open_terminal` accepts multi-segment nested paths, and the web constellation drills into nested targets segment by segment.
- **`@axel/observability` package.** Local, append-only per-session recorder (user inputs, wire events, raw model turns, throttled UI-state snapshots) plus `SessionReader` / `reconstruct` / `diffUiVsBackend` and a read-only stdio MCP server (`axel-observe-mcp`) for diagnosing UI-vs-backend divergence. Recording is local-only, on by default, and controlled by `OBSERVABILITY_ENABLED` / `OBSERVABILITY_DIR`.
- **Local-model tool-calling harness.** New paraphrase-driven eval harness (`packages/agent/tests/tool-harness/`) that verifies small local models actually invoke tools across varied phrasings instead of overfitting to one sentence; gated on a live Ollama instance and skipped otherwise.
- **New test suites** for transcript reading, terminal reuse, project discovery, report-broker lifecycle, and Ollama text-JSON fallback parsing.

### Changed

- **Model-driven project routing.** The server-side keyword matcher (`scoreProject` / `detectTargets`) is gone — every message goes to the root agent, which reads the enumerated project list (now included in its prompt) and resolves fuzzy or spoken repo references itself. Multi-repo fan-out is now model-decided.
- **Smarter child completion detection.** A child terminal's turn end is now its explicit `report()` call, with idle-at-prompt and output-silence fallbacks; the root agent's auto-wake fires only on real completion with fresh output (fixes pings mid-work and silence at completion). Ready-detection gains a raw-silence fallback so unrecognized TUI prompts no longer wait out the 45s hard cap.
- **Local-tier prompting overhaul.** Tier instructions no longer tell local models to "emit JSON" (which broke native tool calling); `q4-local` / `q2-local` tiers get compact system prompts, local root agents get an orchestration-only toolset, and the Ollama provider recovers tool calls that models print as JSON text. Tool descriptions were rewritten to disambiguate read/display/search.
- Sampling `options` (temperature, seed, …) now pass through the Ollama provider.

### Fixed

- `Dockerfile.public` installs `python3`/`make`/`g++` in the node build stage so `node-pty` compiles from source on `node:22-slim`.
- Phase B/C test suites resolve the repo path relative to the test file instead of a hardcoded absolute path.

## [1.0.0] — 2026-06-18

Initial public release.
