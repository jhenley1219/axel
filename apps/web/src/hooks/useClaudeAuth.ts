import { useState, useEffect, useCallback } from 'react'
import { getClaudeStatus } from '../api.js'

export type ClaudeAuthState = 'loading' | 'logged-in' | 'logged-out' | 'awaiting-callback'

export function useClaudeAuth() {
  const [status, setStatus] = useState<ClaudeAuthState>('loading')
  const [email, setEmail] = useState<string | undefined>()
  const [loginUrl, setLoginUrl] = useState<string | undefined>()
  const [callbackInput, setCallbackInput] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const d = await getClaudeStatus()
      if (d.loggedIn) { setStatus('logged-in'); setEmail(d.email) }
      else setStatus('logged-out')
    } catch { setStatus('logged-out') }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const startLogin = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // Server is idempotent: returns the existing URL if one is in flight, or
      // { pending: true } if the python proc is still mid-spawn. Poll briefly
      // for the URL in the pending case rather than re-POSTing (which used to
      // kill the in-flight proc).
      let url: string | undefined
      for (let i = 0; i < 8 && !url; i++) {
        const r = await fetch('/auth/claude/start-oauth', { method: 'POST', credentials: 'include' })
        const d = await r.json() as { ok: boolean; url?: string; pending?: boolean }
        if (d.ok && d.url) { url = d.url; break }
        if (!d.ok) break
        await new Promise(r => setTimeout(r, 1500))
      }
      if (!url) return
      setLoginUrl(url)
      setStatus('awaiting-callback')
      // Poll status until both loggedIn and an email are populated — guards
      // against a transient response that's logged-in but missing the email.
      const deadline = Date.now() + 6 * 60 * 1000
      const interval = setInterval(async () => {
        if (Date.now() > deadline) { clearInterval(interval); return }
        const sd = await getClaudeStatus()
        if (sd.loggedIn && sd.email) {
          clearInterval(interval)
          setStatus('logged-in')
          setEmail(sd.email)
        }
      }, 5000)
    } catch { /* ignore */ }
    finally { setBusy(false) }
  }, [busy])

  const completeLogin = useCallback(async () => {
    if (!callbackInput.trim()) return
    setBusy(true)
    try {
      const r = await fetch('/auth/claude/complete-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: callbackInput.trim() }),
      })
      const d = await r.json() as { ok: boolean; loggedIn?: boolean; email?: string }
      if (d.loggedIn) { setStatus('logged-in'); setEmail(d.email) }
      else await refresh()
    } catch { /* ignore */ }
    finally { setBusy(false); setCallbackInput('') }
  }, [callbackInput, refresh])

  const logout = useCallback(async () => {
    await fetch('/auth/claude/logout', { method: 'POST', credentials: 'include' })
    setStatus('logged-out'); setEmail(undefined); setLoginUrl(undefined)
  }, [])

  return { status, email, loginUrl, callbackInput, setCallbackInput, busy, startLogin, completeLogin, logout, refresh }
}
