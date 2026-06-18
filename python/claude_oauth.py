#!/usr/bin/env python3
"""
Drives `claude auth login --claudeai` to capture the OAuth URL and relay the auth code.

We deliberately use `auth login --claudeai`, NOT `setup-token`:
  - setup-token is for a long-lived API key (scope: user:inference only) and
    stores it as an API token, not as a Claude.ai subscription OAuth account.
  - auth login --claudeai is the proper subscription OAuth flow (scope:
    user:profile + user:inference + user:sessions:claude_code + user:mcp_servers
    + user:file_upload + org:create_api_key) and populates oauthAccount in
    ~/.claude.json so the agent can run with the user's Claude subscription.

The REPL /login path is too fragile (theme picker, trust prompt, version popups
intervene). `auth login` is a top-level subcommand that boots straight into the
OAuth flow: prints "If the browser didn't open, visit: <URL>" then waits at
"Paste code here if prompted > " for the code from stdin.

Wire protocol (stdout, one per line):
  URL:<https-url>     — emitted as soon as the URL is captured
  DONE:ok             — emitted once `claude auth status` reports loggedIn:true
  ERROR:<msg>         — emitted on unrecoverable failure
"""
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, time

CLAUDE_BIN  = os.environ.get('CLAUDE_PATH', 'claude')
ANSI_RE     = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?(\x07|\x1b\\)|\r')
URL_RE      = re.compile(r'https://[A-Za-z0-9._\-/?=&%:#+]+')

# Wide PTY so the URL doesn't wrap. Even with wrap it works (we strip newlines)
# but a single-line URL is easier to debug.
master_fd, slave_fd = pty.openpty()
fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))

env = dict(os.environ)
env['BROWSER'] = '/usr/bin/false'  # force the "browser didn't open" code path
env['TERM']    = 'xterm-256color'
env.pop('DISPLAY', None)

proc = subprocess.Popen(
    [CLAUDE_BIN, 'auth', 'login', '--claudeai'],
    stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
    close_fds=True, env=env,
)
os.close(slave_fd)

def log(msg: str):
    sys.stderr.write(msg + '\n')
    sys.stderr.flush()

def send(data: bytes, label: str = ''):
    try:
        os.write(master_fd, data)
        log(f'[send] {label}: {data!r}')
    except OSError as e:
        log(f'[send error] {e}')

def drain(secs: float = 0.5) -> str:
    chunks, deadline = [], time.time() + secs
    while time.time() < deadline:
        try:
            r, _, _ = select.select([master_fd], [], [], 0.1)
            if r:
                raw = os.read(master_fd, 16384)
                chunk = ANSI_RE.sub('', raw.decode('utf-8', errors='replace'))
                chunks.append(chunk)
        except OSError:
            break
    out = ''.join(chunks)
    if out.strip():
        log(f'[pty] {out!r}'[:400])
    return out

def has_credentials() -> bool:
    """Authoritative check — claude reports its own auth status."""
    try:
        out = subprocess.check_output(
            [CLAUDE_BIN, 'auth', 'status', '--json'],
            stderr=subprocess.DEVNULL, timeout=5,
        )
        d = json.loads(out)
        return bool(d.get('loggedIn'))
    except Exception:
        return False

def extract_url(buf: str) -> str | None:
    """
    setup-token wraps the URL across lines. Reassemble by stripping whitespace
    from inside the URL segment.
    """
    if 'https://' not in buf:
        return None
    start = buf.find('https://')
    rest = buf[start:]
    # Stop at the next prompt marker
    for marker in ('\nPaste', '\npaste ', '\n\n', 'Paste code', 'paste code'):
        idx = rest.find(marker)
        if idx > 0:
            rest = rest[:idx]
            break
    # Re-join wrapped URL
    candidate = re.sub(r'\s+', '', rest)
    m = URL_RE.match(candidate)
    return m.group(0) if m else None

buf = ''
start = time.time()
url_sent = False
code_sent = False

while time.time() - start < 180:
    chunk = drain(0.5)
    buf += chunk

    if not url_sent:
        url = extract_url(buf)
        if url:
            print(f'URL:{url}', flush=True)
            print('PORT:0', flush=True)
            log(f'[found] {url}')
            url_sent = True
            buf = ''

    if url_sent:
        if has_credentials():
            print('DONE:ok', flush=True)
            log('[done] credentials written')
            break
        # Forward an auth code from the Node server (stdin) into the PTY
        if not code_sent:
            try:
                r, _, _ = select.select([sys.stdin], [], [], 0)
                if r:
                    code = sys.stdin.readline().strip()
                    if code:
                        send((code + '\r').encode(), 'auth code')
                        code_sent = True
            except Exception as e:
                log(f'[stdin error] {e}')

    if proc.poll() is not None:
        log(f'[child exited] code={proc.returncode}')
        if not url_sent:
            print(f'ERROR:claude setup-token exited {proc.returncode}', flush=True)
        break

    if not chunk and not url_sent:
        elapsed = int(time.time() - start)
        if elapsed > 0 and elapsed % 10 == 0:
            log(f'[waiting] t={elapsed}s url_sent={url_sent}')

try: proc.terminate()
except Exception: pass
try: os.close(master_fd)
except OSError: pass
