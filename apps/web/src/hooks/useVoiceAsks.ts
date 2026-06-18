// One pending voice question at a time — the user heard it and the next
// recognized utterance is the answer. Covers permission yes/no, transcript
// pick, transcript-length choice; new flows just register another VoiceAsk
// shape. While set, the recognition callback routes utterances through this
// hook instead of the agent, and the TTS-drain callback re-arms the mic
// regardless of whether the agent turn is "done" — the user is the only one
// who can unblock the floor.
//
// Contract: exactly one ask in flight. If a new ask arrives while one is
// pending, the caller should either skip or queue it themselves — this hook
// returns false from `ask()` so the caller knows. `cancel(id)` clears the
// ask externally (e.g. when an inline click resolved a permission and the
// server echoed `permission_resolved`).
import { useCallback, useRef } from 'react'
import type { TtsEngine } from './useTtsEngine.js'
import type { OrbState } from '../components/Voice/VoiceOrb.js'

export type VoiceAskOutcome =
  | { kind: 'answered'; action: () => void }
  | { kind: 'unclear' }
  | { kind: 'cancelled' }

export type VoiceAsk = {
  // Stable id so `cancel(id)` can target the exact ask (the same id used for
  // permission_request from the server, or a uuid for client-generated asks).
  id: string
  question: string
  // Parse the user's reply. Return 'answered' to settle and run an action,
  // 'unclear' to re-prompt the question and keep listening, 'cancelled' to
  // drop the ask silently (e.g. the user said "never mind").
  parse: (utterance: string) => VoiceAskOutcome
  // What to say when the user is unclear. Defaults to a generic retry of the
  // original question.
  reprompt?: string
}

export type VoiceAsks = {
  // Register a new ask. Speaks the question and starts listening for the
  // answer. Returns false if there's already an ask pending — caller decides
  // whether to drop or defer.
  ask: (a: VoiceAsk) => boolean
  // Route a recognized utterance. 'handled' = the hook consumed it; the
  // caller should NOT fall through to sendTranscript. 'pass' = no ask
  // pending, caller does the normal thing.
  route: (utterance: string) => 'handled' | 'pass'
  // True while an ask is pending — the TTS-drain callback uses this to know
  // it should re-arm the mic even when the agent turn isn't done.
  hasPending: () => boolean
  // External cancel — e.g. the server echoed permission_resolved because the
  // user clicked the inline card instead of speaking.
  cancel: (id: string) => void
}

export function useVoiceAsks(
  tts: TtsEngine,
  setOrbState: (s: OrbState) => void,
): VoiceAsks {
  const pendingRef = useRef<VoiceAsk | null>(null)

  // Queue text behind any in-flight TTS — never interrupt, the previous
  // sentence might be load-bearing context for the question. flushMessage
  // first so a half-built agent buffer doesn't get tacked onto our text.
  // endStream sets streamDone so when the queue drains, onAllDone fires and
  // the mic re-arms via the hasPending() check in the parent hook.
  const speak = useCallback((text: string) => {
    setOrbState('responding')
    tts.flushMessage()
    tts.pushToken(text)
    tts.flushMessage()
    tts.endStream()
  }, [tts, setOrbState])

  const ask = useCallback((a: VoiceAsk): boolean => {
    if (pendingRef.current) return false
    pendingRef.current = a
    speak(a.question)
    return true
  }, [speak])

  const route = useCallback((utterance: string): 'handled' | 'pass' => {
    const pending = pendingRef.current
    if (!pending) return 'pass'
    const outcome = pending.parse(utterance)
    if (outcome.kind === 'answered') {
      pendingRef.current = null
      outcome.action()
      // Idle until the next TTS or agent token; if the action voiced its own
      // follow-up that started a new ask, hasPending() is true again.
      setOrbState('idle')
      return 'handled'
    }
    if (outcome.kind === 'cancelled') {
      pendingRef.current = null
      setOrbState('idle')
      return 'handled'
    }
    speak(pending.reprompt ?? `Sorry. ${pending.question}`)
    return 'handled'
  }, [speak, setOrbState])

  const hasPending = useCallback((): boolean => pendingRef.current !== null, [])

  const cancel = useCallback((id: string): void => {
    if (pendingRef.current?.id === id) pendingRef.current = null
  }, [])

  return { ask, route, hasPending, cancel }
}
