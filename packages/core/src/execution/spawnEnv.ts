// Env for spawned helper processes (claude CLI, python scripts).
// Passes the parent env through so the child inherits the user's PATH,
// shell-exported tokens (SLACK_TOKEN, GH_TOKEN, etc.), and any vars their
// user-configured MCP servers depend on. Fallback defaults cover bare
// runtimes like Docker where these may be unset; `extra` overrides both.
export function spawnEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/home/axel',
    TERM: process.env.TERM ?? 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
