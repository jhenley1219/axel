// Short non-speech audio cues for voice-capture start/end. Cohen, Giangola &
// Balogh (2004) — VUI Design: earcons confirm state transitions faster than
// visual feedback and work when the user isn't looking at the screen (Axel's
// iPhone-over-Tailscale use case).
//
// One shared AudioContext, lazy-init on first beep. iOS Safari requires a
// user gesture to start audio — the first beep is always inside a tap handler
// (startListening), so the context unlocks naturally.

let ctxRef: AudioContext | null = null

function ctx(): AudioContext | null {
  if (ctxRef) return ctxRef
  const AC = window.AudioContext ?? window.webkitAudioContext
  if (!AC) return null
  ctxRef = new AC({ latencyHint: 'interactive' })
  return ctxRef
}

function tone(freq: number, durMs: number, peak = 0.08): void {
  const ac = ctx()
  if (!ac) return
  const now = ac.currentTime
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  // 8ms attack / 80% decay envelope — clean chirp, no click on start/stop.
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(peak, now + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durMs / 1000)
  osc.connect(gain).connect(ac.destination)
  osc.start(now)
  osc.stop(now + durMs / 1000 + 0.02)
}

export function beepStart(): void { tone(880, 110) }
export function beepEnd(): void   { tone(520, 90) }
