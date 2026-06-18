// Projected view of one installed tool sent on the wire. Built from
// AppRegistration + optional presentation block, plus the builtins. The bubble
// bar renders bubbles purely from these — no React shipped per tool.
export type ToolPresentation = {
  label?: string                     // bubble caption (defaults to name)
  icon?: string                      // builtin glyph id (e.g. 'gear', 'spark')
  accent?: string                    // CSS color for active/hover tint
  summary?: string                   // hover blurb
  result?: unknown                   // ToolPanelSpec — typed in spec.ts on the web side
  hover?: unknown                    // ToolPanelSpec
}
export type InstalledToolView = {
  name: string                       // unique key — matches MCP server name
  kind: 'builtin' | 'http' | 'stdio'
  description?: string
  presentation?: ToolPresentation
}

// Canonical wire protocol for the /agent/stream WebSocket.
// The web client's ServerMsg type in useVoiceInterface.ts must mirror this exactly.
//
// `target` (optional): when the orchestrator fans a single user message out to
// multiple parallel agents (one per project dir), every event from a child
// agent is tagged with the project's id (e.g. "rta-blueprint-react-ui-azure").
// Events without `target` come from the main/single session.
//
// `term` (optional): which terminal of a target dir the event belongs to. A
// dir can host several independent conversations ("terminals", rendered as
// tabs); missing term means the dir's default terminal ('main').
export type AgentWireMessage =
  | { type: 'token'; value: string; target?: string; term?: string }
  | { type: 'message_end'; target?: string; term?: string }
  // Per-call tool lifecycle. `invocationId` is the claude stream's tool_use id,
  // which the matching tool_result references — same value flows on tool_use →
  // (optional tool_progress) → tool_end. The UI keys per-bubble activity
  // (pulse/flash, in-flight count) on this id so concurrent calls to the same
  // tool animate independently.
  | { type: 'tool_use'; name: string; invocationId: string; input?: unknown; target?: string; term?: string }
  // Optional in-flight updates from tools that stream progress. `patch` is
  // deep-merged into the panel renderer's `stream.*` binding scope so refs
  // flip live without remounting the bubble.
  | { type: 'tool_progress'; invocationId: string; patch: Record<string, unknown>; target?: string; term?: string }
  // The call settled. `ok=false` carries `error` (string from the tool_result
  // block); `ok=true` carries `result` (the tool_result content, opaque).
  | { type: 'tool_end'; invocationId: string; ok: boolean; result?: unknown; error?: string; target?: string; term?: string }
  | { type: 'task_plan'; tasks: Array<{ id: string; name: string; dir: string; order: number }> }
  | { type: 'fan_out'; targets: Array<{ id: string; name: string; dir: string }> }
  | { type: 'target_start'; target: string; term?: string }
  | { type: 'target_done'; target: string; term?: string }
  | { type: 'done' }
  | { type: 'error'; message: string; target?: string; term?: string }
  | { type: 'auth_url'; url: string }
  // A spawned claude is waiting for the user to approve/deny one tool call
  // (permission mode 'default'/'acceptEdits'). The client answers with a
  // `permission_response` control message: { type, id, behavior: 'allow'|'deny' }.
  | { type: 'permission_request'; id: string; toolName: string; input?: unknown; target?: string; term?: string }
  // The request settled (user action, timeout auto-deny, or process exit) —
  // clients drop any pending prompt with this id.
  | { type: 'permission_resolved'; id: string; target?: string; term?: string }
  // A spawned claude wants the user to pick from N options. The client answers
  // with `question_response`: { type, id, index } where `index` is the chosen
  // option's position. `target`/`term` route the prompt to the owning terminal
  // when the asker is a child spawn (same routing as permissions).
  | { type: 'question_request'; id: string; question: string; options: Array<string>; target?: string; term?: string }
  // The question settled (user picked, cancelled, timed out, or the spawn
  // exited before answering). Clients drop any pending question UI with this id.
  | { type: 'question_resolved'; id: string; target?: string; term?: string }
  // A sub-agent (child spawn) raised a request that must route through the
  // main/root agent — the root surfaces it to the user, gathers their answer,
  // and resolves it back to the waiting sub-agent. Distinct from
  // `question_request` (sub-agent → user directly): queue items go via root,
  // ride the existing per-dir/per-term queue, and drive the constellation orb
  // to the sender dir on claim. Broadcast so every client renders the badge.
  | { type: 'queue_added';
      id: string;
      fromTarget: string;
      fromTerm?: string;
      kind: 'proposal' | 'question' | 'confirmation';
      prompt: string;
      options?: Array<string> }
  // Root agent took ownership of a queue item and is presenting it to the user.
  // The constellation engine reacts by floating the orb to `fromTarget` (same
  // path as `target_start` → `ensureSystemOpen`).
  | { type: 'queue_claimed'; id: string; fromTarget: string; fromTerm?: string }
  // Item settled (user accepted/denied, timed out, or the sub-agent exited
  // before an answer). Clients drop the badge entry; the sub-agent's blocked
  // `queue_request` call returns with `{ accepted, answer? }`.
  | { type: 'queue_resolved';
      id: string;
      fromTarget: string;
      fromTerm?: string;
      accepted: boolean;
      answer?: string }
  // A new terminal was opened for a target dir (by the model's open_terminal
  // tool, or echoed for symmetry) — the client materializes an empty tab.
  | { type: 'terminal_open'; target: string; term: string }
  // The orchestrator closed an idle dir (no live runs, queued runs, or open
  // tool spawns) in response to the agent's close_idle_dirs sweep. The client
  // plays the existing close-system animation.
  | { type: 'dir_closed'; target: string }
  // The model asked the UI to surface a file. Fire-and-forget: the agent's
  // open_file tool returns immediately; the user reacts (edit / accept the
  // suggestion / close) on their own time. Highlights are literal substrings
  // wrapped in the editor UI; an optional suggestion is a find/replace pair
  // the user can accept with one click.
  | { type: 'file_open_request';
      path: string;
      highlights?: Array<{ snippet: string; reason?: string; kind?: 'warn' | 'error' | 'info' }>;
      suggestion?: { find: string; replace: string; reason?: string };
      prompt?: string;
      target?: string; term?: string }
  // Pushed (not in response to a prompt) when the set of directories under the
  // projects root changes — a dir was created or removed by the user or an
  // agent. The web client reacts by surgically re-pulling the project list so
  // the constellation ring updates live, without a full page reload.
  | { type: 'fs_changed' }
  // Emitted by AxelAgent's UI-open tools — the web client maps these to the
  // same actions a user click triggers.
  | { type: 'ui_open_file'; path: string; target?: string; term?: string }
  | { type: 'ui_open_dir'; path: string; target?: string; term?: string }
  // Sent once per WS connection right after auth, so a freshly-opened tab is
  // in sync without waiting for a registry change. Clients REPLACE their
  // bubble-bar list. Idempotent.
  | { type: 'tool_catalog'; tools: Array<InstalledToolView> }
  // Broadcast when a tool registration appears or changes on disk (install
  // succeeded, or the user edited a file by hand). Clients UPSERT by `name`.
  | { type: 'tool_registered'; tool: InstalledToolView }
  // Broadcast when a registration file is deleted (uninstall, or the user
  // nuked the file). Clients drop the bubble by name.
  | { type: 'tool_unregistered'; name: string }
  // Live state for a built-in app (timer, notes). Broadcast on every mutation
  // — whether the agent caused it via an MCP tool, or the user caused it via
  // an `app_action` control message from a bubble popup. Clients update their
  // local state slice so every open tab stays in sync without polling.
  // `state === null` for the timer means "no timer is running" — the bubble
  // drops its is-active class.
  | { type: 'app_state'; app: 'timer' | 'notes'; state: unknown }
  // The agent runtime opened an interactive `claude` PTY for this (target, term).
  // The client connects an xterm.js view to /agent/pty/<spawnId> for bytes both
  // directions. One emission per PTY lifetime — re-emitted if the PTY is closed
  // and reopened on a later turn.
  | { type: 'pty_ready'; spawnId: string; target?: string; term?: string }
