import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { createPairToken, type PairTokenResponse } from '../../api.js'

type State =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ready'; data: PairTokenResponse; pairUrl: string }
  | { kind: 'error'; message: string }

// Render a QR code that opens /auth/pair/consume?token=… on the phone. The
// scanned URL hands the phone a session cookie and bounces it to /, so the
// user never types their password on the phone. Single-use, 5-minute TTL.
export function PairPhone() {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [now, setNow] = useState(() => Date.now())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const generate = useCallback(async () => {
    setState({ kind: 'pending' })
    try {
      const data = await createPairToken()
      if (!data.ok) {
        setState({ kind: 'error', message: 'Could not create a pairing link.' })
        return
      }
      if (!data.lanIp) {
        setState({ kind: 'error', message: 'No LAN address found — connect to WiFi and try again.' })
        return
      }
      if (!data.httpsAvailable) {
        setState({ kind: 'error', message: 'HTTPS isn\'t enabled on this server — the phone needs a secure context for voice.' })
        return
      }
      const pairUrl = `https://${data.lanIp}:${data.httpsPort}/auth/pair/consume?token=${encodeURIComponent(data.token)}`
      setState({ kind: 'ready', data, pairUrl })
      setNow(Date.now())
    } catch {
      setState({ kind: 'error', message: 'Network error — is the server still running?' })
    }
  }, [])

  // Paint the QR onto the canvas whenever the URL changes. Errors here are
  // unrecoverable user-visible failures (canvas missing, etc.) — flip to
  // error state so the user can re-roll.
  useEffect(() => {
    if (state.kind !== 'ready' || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, state.pairUrl, {
      width: 220,
      margin: 1,
      color: { dark: '#0a0a0a', light: '#ffffff' },
    }).catch(() => setState({ kind: 'error', message: 'Could not render QR code.' }))
  }, [state])

  // Lightweight 1s tick so the countdown text actually counts down. Only
  // runs while a token is on-screen.
  useEffect(() => {
    if (state.kind !== 'ready') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [state.kind])

  const expired = state.kind === 'ready' && now >= state.data.expiresAt
  const remainingSec = state.kind === 'ready' ? Math.max(0, Math.floor((state.data.expiresAt - now) / 1000)) : 0

  return (
    <section className="ax-settings-section">
      <h5>Pair phone</h5>
      <p className="ax-settings-hint">
        Generate a QR code, then scan it with your phone's camera. The phone
        opens the same session you have here. Phone and laptop must be on the
        same WiFi network.
      </p>

      {state.kind === 'idle' && (
        <button className="ax-settings-btn primary" onClick={generate}>
          Generate pairing code
        </button>
      )}

      {state.kind === 'pending' && (
        <button className="ax-settings-btn primary" disabled>Generating…</button>
      )}

      {state.kind === 'error' && (
        <>
          <p className="ax-settings-hint" style={{ color: '#ff8' }}>{state.message}</p>
          <button className="ax-settings-btn primary" onClick={generate}>Try again</button>
        </>
      )}

      {state.kind === 'ready' && (
        <>
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            background: '#fff',
            borderRadius: 8,
            padding: 10,
            margin: '8px 0',
          }}>
            <canvas ref={canvasRef} aria-label="Pairing QR code" />
          </div>
          <p className="ax-settings-hint">
            Open your phone's camera, point it at the QR, tap the link.
            <br />
            <strong>First time?</strong> Safari warns about the self-signed
            cert — tap "Advanced" → "Visit this website" to accept. Only happens
            once per phone.
          </p>
          <p className="ax-settings-hint" style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>
            URL: <code>{state.pairUrl.replace(/token=[^&]+/, 'token=…')}</code>
          </p>
          {expired ? (
            <>
              <p className="ax-settings-hint" style={{ color: '#ff8' }}>This code has expired.</p>
              <button className="ax-settings-btn primary" onClick={generate}>Generate a new code</button>
            </>
          ) : (
            <>
              <p className="ax-settings-hint">Expires in {remainingSec}s · single use.</p>
              <button className="ax-settings-btn ghost" onClick={generate}>Regenerate</button>
            </>
          )}
        </>
      )}
    </section>
  )
}
