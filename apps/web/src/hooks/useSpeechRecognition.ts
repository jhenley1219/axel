import { useState, useRef, useCallback, useEffect } from 'react'

const STOP_WORDS = ['done', 'send', 'send it', 'stop', 'go', 'submit', 'that\'s all']

export type SpeechRecognitionEngine = {
  liveTranscript: string
  // Begin a listening turn; returns false when SR is unavailable or already
  // running. Caller is responsible for "should we listen now" guards
  // (busy/orb state); the engine only guards against double-starts.
  start: () => boolean
  // Close the mic and dispatch whatever was said.
  stop: () => void
  // Close the mic WITHOUT dispatching — returns the partial transcript so the
  // caller can pre-fill a text input for the user to finish typing.
  cancel: () => string
}

// Wraps webkitSpeechRecognition's restart dance. The engine has internal
// timeouts (~1 min segment limit, ~5-10 s silence detection) that fire `onend`
// regardless of `continuous: true` — we transparently restart a fresh SR
// instance on every engine-initiated end, preserving the accumulated
// transcript so nothing is lost mid-sentence.
//
// onFinish receives the final transcript ('' when cancelled or nothing was
// said). onStatus surfaces mic errors/hints for the status line.
export function useSpeechRecognition(
  onFinish: (transcript: string) => void,
  onStatus: (msg: string) => void,
): SpeechRecognitionEngine {
  const [liveTranscript, setLiveTranscript] = useState('')

  const onFinishRef = useRef(onFinish)
  const onStatusRef = useRef(onStatus)
  useEffect(() => { onFinishRef.current = onFinish })
  useEffect(() => { onStatusRef.current = onStatus })

  const srRef               = useRef<SpeechRecognition | null>(null)
  const finalAccumRef       = useRef('')   // text committed from prior SR sessions this turn
  const currentSessionRef   = useRef('')   // text from the live SR session
  const intentionalStopRef  = useRef(false)
  const cancelledRef        = useRef(false) // cancel without sending (pre-fill text input instead)
  const listenStartedAtRef  = useRef(0)
  const stopTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null)

  const start = useCallback((): boolean => {
    if (srRef.current) return false   // already listening — don't double-start

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) {
      onStatusRef.current('Voice input not available — type your message below')
      return false
    }

    // Auto-stop policy (applies across SR restarts in this listening turn):
    //   - SILENCE_MS: idle time after the LAST detected speech before we
    //     close the mic for real. Long enough that a thoughtful mid-sentence
    //     pause won't kill the recording.
    //   - MIN_RECORD_MS: hard floor — auto-stop cannot fire within this
    //     many ms of starting.
    const SILENCE_MS = 3000
    const MIN_RECORD_MS = 2000

    finalAccumRef.current      = ''
    currentSessionRef.current  = ''
    intentionalStopRef.current = false
    listenStartedAtRef.current = Date.now()
    setLiveTranscript('')
    onStatusRef.current('')

    const clearStop = () => {
      if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null }
    }
    const armStop = () => {
      clearStop()
      const elapsed = Date.now() - listenStartedAtRef.current
      const wait = Math.max(SILENCE_MS, MIN_RECORD_MS - elapsed)
      stopTimerRef.current = setTimeout(() => {
        // Timer expiring counts as an intentional stop — we WANT to close
        // the mic and dispatch what's been said.
        intentionalStopRef.current = true
        try { srRef.current?.stop() } catch { /* ignore */ }
      }, wait)
    }

    const dispatch = () => {
      clearStop()
      // Roll any in-flight session text into the accumulator so we don't
      // lose final words that arrived between the last result event and end.
      if (currentSessionRef.current.trim()) {
        finalAccumRef.current = (finalAccumRef.current + ' ' + currentSessionRef.current).trim()
        currentSessionRef.current = ''
      }
      srRef.current = null
      setLiveTranscript('')
      const transcript = finalAccumRef.current.trim()
      finalAccumRef.current = ''
      if (cancelledRef.current) {
        cancelledRef.current = false
        onFinishRef.current('')
        return
      }
      onFinishRef.current(transcript)
    }

    // Rate-limiting state for SR restart loop prevention
    let srRestartCount = 0   // consecutive empty restarts
    let lastSrStartMs  = 0   // timestamp of last sr.start()

    const startNewSr = () => {
      // ── Rate-limit: don't restart faster than every 350ms ──────────────
      // This is the primary fix for the "mic icon flashing" bug. When SR ends
      // immediately (Chrome throttle, network hiccup, hardware issue), the
      // onend→startNewSr loop would run at 60fps without this guard.
      const now = Date.now()
      const msSinceLast = now - lastSrStartMs
      if (lastSrStartMs > 0 && msSinceLast < 350) {
        const delay = 350 - msSinceLast
        setTimeout(() => { if (!intentionalStopRef.current) startNewSr() }, delay)
        return
      }

      // ── Give up after 5 consecutive restarts without any speech ────────
      // Safety only applies BEFORE the first captured word. Once anything
      // is in finalAccumRef, the silence timer (3s after last speech,
      // armed in onresult) owns dispatch — keep restarting so iOS Safari
      // (which ends the SR session after the first finalized word on a
      // cold mic) has more chances to land additional words mid-thought.
      // Without this, the first iPhone turn cuts off ~1.75s in with only
      // the first word captured.
      if (!finalAccumRef.current.trim()) {
        srRestartCount++
        if (srRestartCount > 5) {
          srRestartCount = 0
          onStatusRef.current('Mic unavailable — tap orb to retry')
          dispatch()
          return
        }
      }

      lastSrStartMs = now

      const sr = new SR()
      sr.continuous = true
      sr.interimResults = true
      sr.lang = 'en-US'

      sr.onresult = (e: SpeechRecognitionEvent) => {
        let text = ''
        for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
        currentSessionRef.current = text
        setLiveTranscript((finalAccumRef.current + ' ' + text).trim())

        // Got actual speech — reset restart counter
        if (text.trim()) srRestartCount = 0

        const latest = e.results[e.results.length - 1]
        const word = latest?.[0]?.transcript?.toLowerCase()?.trim() ?? ''
        if (latest?.isFinal && STOP_WORDS.some(w => word === w || word.endsWith(' ' + w))) {
          intentionalStopRef.current = true
          try { sr.stop() } catch { /* ignore */ }
          return
        }
        armStop()
      }

      sr.onerror = (e: SpeechRecognitionErrorEvent) => {
        // Permanent errors: mark intentional so onend doesn't restart
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          intentionalStopRef.current = true
          onStatusRef.current('Microphone access denied — allow mic in browser settings, then tap orb')
        } else if (e.error === 'audio-capture') {
          intentionalStopRef.current = true
          onStatusRef.current('Microphone not available — check system settings')
        } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
          // Transient errors: log but let onend decide whether to restart
          onStatusRef.current(`Mic error: ${e.error}`)
        }
      }

      sr.onend = () => {
        if (currentSessionRef.current.trim()) {
          finalAccumRef.current = (finalAccumRef.current + ' ' + currentSessionRef.current).trim()
          currentSessionRef.current = ''
        }
        if (intentionalStopRef.current) {
          dispatch()
          return
        }
        // Engine-initiated end — restart with rate-limiting applied above
        try {
          startNewSr()
        } catch {
          dispatch()
        }
      }

      srRef.current = sr
      try { sr.start() } catch { /* ignore — onend will fire */ }
    }

    startNewSr()
    armStop()
    return true
  }, [])

  const stop = useCallback(() => {
    intentionalStopRef.current = true
    try { srRef.current?.stop() } catch { /* ignore */ }
    // onend will fire and handle dispatch
  }, [])

  const cancel = useCallback((): string => {
    const text = (finalAccumRef.current + ' ' + currentSessionRef.current).trim()
    cancelledRef.current = true
    intentionalStopRef.current = true
    if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null }
    try { srRef.current?.stop() } catch { /* ignore */ }
    return text
  }, [])

  return { liveTranscript, start, stop, cancel }
}
