import { useState } from 'react'
import { login, setup } from '../../api.js'
import { primaryBtnStyle } from '../../styles/buttons.js'

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '3rem', padding: '2rem' },
  name: { fontSize: '2.5rem', fontWeight: 800, letterSpacing: '0.15em', color: '#f0f0f0' },
  tagline: { fontSize: '0.8rem', color: '#444', letterSpacing: '0.2em', textTransform: 'uppercase' },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem', width: '280px' },
  input: { background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '0.75rem 1rem', color: '#f0f0f0', fontSize: '0.95rem', outline: 'none', width: '100%', boxSizing: 'border-box' },
  error: { color: '#ef4444', fontSize: '0.8rem', textAlign: 'center', minHeight: '1rem' } as React.CSSProperties,
  hint: { color: '#555', fontSize: '0.75rem', textAlign: 'center' } as React.CSSProperties,
}

const btnStyle = (disabled: boolean): React.CSSProperties =>
  primaryBtnStyle(disabled, { fullWidth: true, borderRadius: '6px' })

type Props = {
  mode: 'setup' | 'login'
  onAuthenticated: () => void
}

export function LockScreen({ mode, onAuthenticated }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (mode === 'setup') {
      if (password.length < 8) { setError('Password must be at least 8 characters'); return }
      if (password !== confirm) { setError('Passwords do not match'); return }
    }

    setLoading(true)
    try {
      const result = mode === 'setup'
        ? await setup(username.trim(), password)
        : await login(username.trim(), password)

      if (result.ok) {
        onAuthenticated()
      } else if ('retryAfterMs' in result && result.retryAfterMs) {
        setError(`Too many attempts — wait ${Math.ceil((result.retryAfterMs as number) / 60000)} min`)
      } else {
        setError(mode === 'setup' ? 'Setup failed' : 'Invalid username or password')
      }
    } finally {
      setLoading(false)
    }
  }

  const disabled = loading || !username || !password

  return (
    <div style={styles.page}>
      <div>
        <div style={styles.name}>AXEL</div>
        <div style={styles.tagline}>{mode === 'setup' ? 'First-Time Setup' : 'Root Controller'}</div>
      </div>
      <form onSubmit={submit} style={styles.form}>
        <input
          style={styles.input}
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
        />
        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
        />
        {mode === 'setup' && (
          <input
            style={styles.input}
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        )}
        <div style={styles.error}>{error}</div>
        <button type="submit" style={btnStyle(disabled)} disabled={disabled}>
          {loading ? '…' : mode === 'setup' ? 'Create Account' : 'Sign In'}
        </button>
        {mode === 'setup' && (
          <div style={styles.hint}>
            Your credentials are stored locally. Only one account can be created.
          </div>
        )}
      </form>
    </div>
  )
}
