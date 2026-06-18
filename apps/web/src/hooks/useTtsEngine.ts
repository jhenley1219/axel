import { useState, useRef, useCallback, useEffect } from 'react'

export type TtsVoice    = 'ava' | 'andrew'
// piper/kokoro = server-side local synthesis; browser = Web Speech API
export type TtsProvider = 'piper' | 'kokoro' | 'browser'

// Pick the best available browser voice. Priority:
//   1. Explicitly selected voice name (user clicked one in settings)
//   2. Name preference (Ava or Andrew) — prefers Online/Neural variants
//   3. First en-US voice
function pickVoice(
  voices: Array<SpeechSynthesisVoice>,
  explicit: string | null,
  want: string,
): SpeechSynthesisVoice | null {
  if (!voices.length) return null
  if (explicit) {
    const exact = voices.find(v => v.name === explicit)
    if (exact) return exact
  }
  return (
    voices.find(v => v.name.toLowerCase().includes(want.toLowerCase()) && v.lang.startsWith('en')) ??
    voices.find(v => v.lang === 'en-US') ??
    voices.find(v => v.lang.startsWith('en')) ??
    null
  )
}

function speakBrowserOnce(
  text: string,
  prefs: { explicit: string | null; want: string },
  onEnd: () => void,
): void {
  if (!window.speechSynthesis) {
    console.warn('[tts] speechSynthesis not available — skipping')
    onEnd()
    return
  }

  const doSpeak = (voices: Array<SpeechSynthesisVoice>) => {
    // iOS: cancel any stuck/silent item in the queue before speaking
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'en-US'
    const v = pickVoice(voices, prefs.explicit, prefs.want)
    console.log(`[tts] browser speak: voice="${v?.name ?? 'none'}" voices_available=${voices.length} text="${text.slice(0, 40)}"`)
    if (v) utter.voice = v
    utter.rate = 1.05
    // iOS pauses speechSynthesis after ~15s of speaking — resume() keeps it alive
    const keepAlive = setInterval(() => {
      if (window.speechSynthesis.speaking) window.speechSynthesis.resume()
    }, 10000)
    utter.onend = () => { clearInterval(keepAlive); console.log('[tts] browser utterance ended'); onEnd() }
    utter.onerror = (e) => { clearInterval(keepAlive); console.warn('[tts] browser utterance error', e.error); onEnd() }
    window.speechSynthesis.speak(utter)
  }

  const voices = window.speechSynthesis.getVoices()
  if (voices.length > 0) {
    doSpeak(voices)
  } else {
    console.log('[tts] waiting for voiceschanged...')
    let fired = false
    const onLoaded = () => {
      if (fired) return
      fired = true
      window.speechSynthesis.removeEventListener('voiceschanged', onLoaded)
      const v2 = window.speechSynthesis.getVoices()
      console.log(`[tts] voiceschanged fired, count=${v2.length}`)
      doSpeak(v2)
    }
    window.speechSynthesis.addEventListener('voiceschanged', onLoaded)
    setTimeout(() => onLoaded(), 500)
  }
}

// The user-facing voice settings (persisted to localStorage) — the slice of
// the engine that settings UI needs, without the playback lifecycle.
export type TtsControls = {
  voice: TtsVoice
  setVoice: (v: TtsVoice) => void
  ttsProvider: TtsProvider
  setTtsProvider: (p: TtsProvider) => void
  browserVoices: Array<{ name: string; lang: string }>
  selectedBrowserVoice: string | null
  setSelectedBrowserVoice: (name: string | null) => void
}

export type TtsEngine = TtsControls & {
  unlock: () => void
  pushToken: (value: string) => void
  flushMessage: () => void
  endStream: () => void
  reset: () => void
  interrupt: () => void
}

// Streaming TTS queue: each completed agent message (delimited by a
// `message_end` event) is synthesized immediately and played in arrival
// order while the agent keeps running. `onAllDone` fires when the stream has
// ended AND the queue has fully drained.
export function useTtsEngine(onAllDone: () => void): TtsEngine {
  const [voice, setVoiceState] = useState<TtsVoice>(
    () => (localStorage.getItem('axel-tts-voice') as TtsVoice) ?? 'ava',
  )
  const [ttsProvider, setTtsProviderState] = useState<TtsProvider>(() => {
    const stored = localStorage.getItem('axel-tts-provider')
    // older builds stored 'edge' — that provider is gone, so fall back
    return stored === 'piper' || stored === 'kokoro' || stored === 'browser' ? stored : 'piper'
  })
  // Exact browser voice name when user explicitly picks one from the list
  const [selectedBrowserVoice, setSelectedBrowserVoiceState] = useState<string | null>(
    () => localStorage.getItem('axel-browser-voice-name'),
  )
  // Available browser voices (English) — populated once voiceschanged fires
  const [browserVoices, setBrowserVoices] = useState<Array<{ name: string; lang: string }>>([])

  const setVoice = useCallback((v: TtsVoice) => {
    localStorage.setItem('axel-tts-voice', v)
    setVoiceState(v)
  }, [])

  const setTtsProvider = useCallback((p: TtsProvider) => {
    localStorage.setItem('axel-tts-provider', p)
    setTtsProviderState(p)
  }, [])

  const setSelectedBrowserVoice = useCallback((name: string | null) => {
    if (name) localStorage.setItem('axel-browser-voice-name', name)
    else localStorage.removeItem('axel-browser-voice-name')
    setSelectedBrowserVoiceState(name)
  }, [])

  // Ref mirrors so the stable queue callbacks always read current prefs
  const voiceRef                = useRef(voice)
  const ttsProviderRef          = useRef(ttsProvider)
  const selectedBrowserVoiceRef = useRef(selectedBrowserVoice)
  useEffect(() => { voiceRef.current = voice },                               [voice])
  useEffect(() => { ttsProviderRef.current = ttsProvider },                   [ttsProvider])
  useEffect(() => { selectedBrowserVoiceRef.current = selectedBrowserVoice }, [selectedBrowserVoice])

  const onAllDoneRef = useRef(onAllDone)
  useEffect(() => { onAllDoneRef.current = onAllDone })

  const audioUnlockedRef = useRef(false)
  const messageBufRef    = useRef('')
  const queueRef         = useRef<Array<{ ready: Promise<ArrayBuffer | null>; text: string }>>([])
  const playingRef       = useRef(false)
  const streamDoneRef    = useRef(true)
  const ctxRef           = useRef<AudioContext | null>(null)   // unlocked AudioContext for server TTS
  const sourceRef        = useRef<AudioBufferSourceNode | null>(null)  // currently playing node

  // ── Enumerate browser voices (English only) for the settings picker ────────
  useEffect(() => {
    const populate = () => {
      const all = window.speechSynthesis?.getVoices() ?? []
      const en  = all.filter(v => v.lang.startsWith('en'))
      if (en.length) setBrowserVoices(en.map(v => ({ name: v.name, lang: v.lang })))
    }
    populate()
    window.speechSynthesis?.addEventListener('voiceschanged', populate)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', populate)
  }, [])

  const speakFallback = useCallback((text: string, onEnd: () => void) => {
    speakBrowserOnce(text, {
      explicit: selectedBrowserVoiceRef.current,
      want: voiceRef.current === 'andrew' ? 'Andrew' : 'Ava',
    }, onEnd)
  }, [])

  const drain = useCallback(() => {
    if (playingRef.current) return
    const next = queueRef.current[0]
    if (!next) {
      if (streamDoneRef.current) {
        console.log('[tts] all done')
        onAllDoneRef.current()
      }
      return
    }
    console.log(`[tts] draining queue, items=${queueRef.current.length}`)
    playingRef.current = true
    next.ready.then(buf => {
      const advance = () => {
        playingRef.current = false
        queueRef.current.shift()
        drain()
      }
      if (!buf) {
        console.log('[tts] no buffer (browser provider) → speakBrowserOnce')
        speakFallback(next.text, advance)
        return
      }
      const ctx = ctxRef.current
      if (!ctx) {
        console.warn('[tts] no AudioContext — falling back to browser TTS')
        speakFallback(next.text, advance)
        return
      }
      console.log('[tts] decoding audio buffer via AudioContext')
      ctx.decodeAudioData(buf,
        (decoded) => {
          const source = ctx.createBufferSource()
          source.buffer = decoded
          source.connect(ctx.destination)
          sourceRef.current = source
          source.onended = () => {
            console.log('[tts] server audio ended')
            sourceRef.current = null
            advance()
          }
          source.start(0)
          console.log('[tts] AudioContext source started')
        },
        (err) => {
          console.warn('[tts] decodeAudioData failed:', err)
          speakFallback(next.text, advance)
        },
      )
    })
  }, [speakFallback])

  const enqueue = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    console.log(`[tts] enqueue provider=${ttsProviderRef.current} text="${trimmed.slice(0, 40)}"`)
    const ready: Promise<ArrayBuffer | null> = ttsProviderRef.current === 'browser'
      ? Promise.resolve(null)
      : fetch('/tts/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, voice: voiceRef.current, provider: ttsProviderRef.current }),
          credentials: 'include',
        })
          .then(r => { console.log(`[tts] synthesize response status=${r.status}`); return r.ok ? r.arrayBuffer() : null })
          .then(buf => { console.log(`[tts] audio buffer size=${buf?.byteLength ?? 0}`); return buf ?? null })
          .catch((err) => { console.warn('[tts] synthesize fetch error:', err); return null })
    queueRef.current.push({ ready, text: trimmed })
    drain()
  }, [drain])

  // Accumulate token text for the message currently streaming in
  const pushToken = useCallback((value: string) => {
    if (streamDoneRef.current) {
      streamDoneRef.current = false
      messageBufRef.current = ''
    }
    messageBufRef.current += value
  }, [])

  // message_end: hand the accumulated message to TTS so it starts speaking
  // now, while the agent continues with tool calls / the next message
  const flushMessage = useCallback(() => {
    const text = messageBufRef.current
    messageBufRef.current = ''
    if (text.trim()) enqueue(text)
  }, [enqueue])

  // done: flush any tail that arrived without a message_end, then fire
  // onAllDone immediately if nothing is queued or playing
  const endStream = useCallback(() => {
    streamDoneRef.current = true
    const tail = messageBufRef.current.trim()
    messageBufRef.current = ''
    if (tail) enqueue(tail)
    if (queueRef.current.length === 0 && !playingRef.current) {
      console.log('[tts] all done')
      onAllDoneRef.current()
    }
  }, [enqueue])

  // error: drop everything pending but let any current playback finish
  const reset = useCallback(() => {
    messageBufRef.current = ''
    queueRef.current = []
    streamDoneRef.current = true
  }, [])

  // Hard stop: drop the queue and silence current playback (barge-in / tap)
  const interrupt = useCallback(() => {
    queueRef.current = []
    messageBufRef.current = ''
    streamDoneRef.current = true
    playingRef.current = false
    const source = sourceRef.current
    if (source) {
      source.onended = null
      try { source.stop() } catch { /* already stopped */ }
      sourceRef.current = null
    }
    window.speechSynthesis?.cancel()
  }, [])

  // Unlock iOS audio on first user gesture. AudioContext.resume() called
  // synchronously inside a tap handler permanently unlocks async playback.
  const unlock = useCallback(() => {
    if (audioUnlockedRef.current) return
    audioUnlockedRef.current = true
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (AC && !ctxRef.current) {
      const ctx = new AC({ latencyHint: 'playback', sampleRate: 44100 })
      ctx.resume().catch(() => {})
      ctxRef.current = ctx
    }
    // Also unlock speechSynthesis for browser TTS fallback
    if (window.speechSynthesis) {
      const silent = new SpeechSynthesisUtterance(' ')
      silent.volume = 0
      silent.onend = () => {}
      window.speechSynthesis.speak(silent)
      setTimeout(() => window.speechSynthesis.cancel(), 50)
    }
    console.log('[tts] audio unlocked via user gesture')
  }, [])

  return {
    voice, setVoice,
    ttsProvider, setTtsProvider,
    browserVoices,
    selectedBrowserVoice, setSelectedBrowserVoice,
    unlock,
    pushToken, flushMessage, endStream, reset, interrupt,
  }
}
