import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, EffortLevel, PermissionMode } from '@axel/core'
import { useSettings } from '../../hooks/useSettings.js'
import { useClaudeAuth } from '../../hooks/useClaudeAuth.js'
import { getOllamaModels, pullOllamaModel } from '../../api.js'
import { DirBrowser } from './DirBrowser.js'
import { PairPhone } from './PairPhone.js'
import type { TtsControls, TtsProvider, TtsVoice } from '../../hooks/useTtsEngine.js'

type AgentRuntime = NonNullable<AppSettings['agentRuntime']>
type RuntimeProvider = NonNullable<AppSettings['runtimeProvider']>
type ModelTier = NonNullable<AppSettings['modelTier']>

// One row in the model picker. Claude rows are static (cloud, fixed list);
// Local rows are discovered at runtime from Ollama's /api/tags. Selecting a
// row writes the implied runtime/provider/tier triple into settings.
type ModelOption = {
  id: string
  label: string
  group: 'Claude' | 'Local'
  runtime: AgentRuntime
  runtimeProvider?: RuntimeProvider
  auth: 'claude-oauth' | 'none'
  defaultTier: ModelTier
  needsBaseURL?: boolean
  baseURLPh?: string
}

const CLAUDE_MODELS: Array<ModelOption> = [
  { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7',   group: 'Claude', runtime: 'claude-code', auth: 'claude-oauth', defaultTier: 'frontier' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Claude', runtime: 'claude-code', auth: 'claude-oauth', defaultTier: 'mid'      },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  group: 'Claude', runtime: 'claude-code', auth: 'claude-oauth', defaultTier: 'mid'      },
]

const DEFAULT_MODEL_ID = 'claude-opus-4-7'
const OLLAMA_BASE_URL_PH = 'http://localhost:11434'

// Rough heuristic for tier inference from the model tag. Sub-7B → q2-local,
// 7B and up → q4-local. Tier only affects prompt composition, so a wrong
// guess is harmless; users with strong opinions can still swap models.
const inferOllamaTier = (id: string): ModelTier => {
  const m = id.match(/(\d+(?:\.\d+)?)\s*b\b/i)
  if (!m) return 'q4-local'
  const billions = parseFloat(m[1])
  return billions < 7 ? 'q2-local' : 'q4-local'
}

const toLocalOption = (m: { id: string; sizeBytes?: number }): ModelOption => {
  const gb = m.sizeBytes ? ` · ${(m.sizeBytes / 1e9).toFixed(1)} GB` : ''
  return {
    id: m.id,
    label: `${m.id} (local · Ollama${gb})`,
    group: 'Local',
    runtime: 'axel',
    runtimeProvider: 'ollama',
    auth: 'none',
    defaultTier: inferOllamaTier(m.id),
    needsBaseURL: true,
    baseURLPh: OLLAMA_BASE_URL_PH,
  }
}

// Old settings.json files may still carry stale openai/custom selections — fall
// back to the default so the dropdown never shows a broken option. `matched`
// tells the caller whether the persisted triple was coherent; if not, the
// useEffect below persists the resolved default so the backend factory never
// sees the stale "axel runtime without runtimeProvider" combo that throws
// "Could not resolve authentication method" on the first agent run.
//
// For axel/ollama we synthesize the ModelOption directly from persisted state
// — discovery is async and we don't want a transient "no models yet" tick to
// blow away the user's saved selection.
const resolveSelectedModel = (
  st: AppSettings,
  localOptions: Array<ModelOption>,
): { model: ModelOption; matched: boolean } => {
  if (st.agentRuntime === 'axel') {
    if (st.runtimeProvider === 'ollama' && st.runtimeModel) {
      const live = localOptions.find(m => m.id === st.runtimeModel)
      if (live) return { model: live, matched: true }
      return { model: toLocalOption({ id: st.runtimeModel }), matched: true }
    }
  } else if (st.agentRuntime === 'claude-code') {
    const hit = CLAUDE_MODELS.find(m => m.id === st.modelId)
    if (hit) return { model: hit, matched: true }
  }
  return { model: CLAUDE_MODELS.find(m => m.id === DEFAULT_MODEL_ID) ?? CLAUDE_MODELS[0], matched: false }
}

// Settings patch for a model selection. Written in one save so the backend
// factory.ts always sees a coherent runtime/provider/model triple.
const buildSelectionPatch = (m: ModelOption): Partial<AppSettings> => {
  const patch: Partial<AppSettings> = { agentRuntime: m.runtime, modelTier: m.defaultTier }
  if (m.runtime === 'claude-code') {
    patch.modelProvider = 'claude-code'
    patch.modelId = m.id
  } else {
    patch.runtimeProvider = m.runtimeProvider
    patch.runtimeModel = m.id
  }
  return patch
}

type Props = {
  open: boolean
  onClose: () => void
  tts: TtsControls
  onProjectsRefresh: () => void
  onMcpRefresh: () => void
}

export function SettingsPanel({ open, onClose, tts, onProjectsRefresh, onMcpRefresh }: Props) {
  const { voice, setVoice, ttsProvider, setTtsProvider, browserVoices, selectedBrowserVoice, setSelectedBrowserVoice } = tts
  const s = useSettings()
  const claude = useClaudeAuth()

  const [selectedId, setSelectedId] = useState<string>(DEFAULT_MODEL_ID)
  const [effort, setEffort] = useState<EffortLevel | ''>('')
  const [baseURL, setBaseURL] = useState<string>('')
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})

  const [browseOpen, setBrowseOpen] = useState(false)
  const [localOptions, setLocalOptions] = useState<Array<ModelOption>>([])
  const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'loading' | 'ok' | 'unreachable'>('idle')

  const [pullName, setPullName] = useState<string>('')
  const [pullState, setPullState] = useState<'idle' | 'pulling' | 'success' | 'error'>('idle')
  const [pullStatus, setPullStatus] = useState<string>('')
  const [pullCompleted, setPullCompleted] = useState<number>(0)
  const [pullTotal, setPullTotal] = useState<number>(0)
  const [pullError, setPullError] = useState<string | null>(null)
  const pullAbortRef = useRef<AbortController | null>(null)

  const selectDir = async (path: string) => {
    await s.save({ projectsRoot: path })
    setBrowseOpen(false)
    onProjectsRefresh()
  }

  // Hits /api/runtime/ollama/models and folds the response into local state.
  // Extracted so the post-pull success path can refresh without changing
  // settings just to retrigger the open-panel useEffect.
  const rescanOllama = useCallback(async (): Promise<void> => {
    setOllamaStatus('loading')
    const r = await getOllamaModels()
    if (r.ok) {
      setLocalOptions(r.models.map(toLocalOption))
      setOllamaStatus('ok')
    } else {
      setLocalOptions([])
      setOllamaStatus('unreachable')
    }
  }, [])

  // Re-scan when the panel opens or the user changes the Ollama base URL.
  // Only fires while open so closed-panel renders don't poke the daemon.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      await rescanOllama()
      if (cancelled) return
    })()
    return () => { cancelled = true }
  }, [open, s.settings.runtimeBaseURL, rescanOllama])

  useEffect(() => {
    if (s.loading || s.saving) return
    const { model, matched } = resolveSelectedModel(s.settings, localOptions)
    setSelectedId(model.id)
    setEffort(s.settings.effortLevel ?? '')
    setBaseURL(s.settings.runtimeBaseURL ?? '')
    // Stale persisted state (e.g. legacy `agentRuntime: "axel"` with no
    // runtimeModel) → write the coherent default so the next agent run hits
    // a valid backend instead of throwing the SDK auth error.
    if (!matched) void s.save(buildSelectionPatch(model))
  }, [s.loading, s.saving, s.settings.modelProvider, s.settings.modelId, s.settings.agentRuntime, s.settings.runtimeProvider, s.settings.runtimeModel, s.settings.runtimeBaseURL, s.settings.effortLevel, localOptions])

  if (!open) return null

  const displayModels: Array<ModelOption> = [...CLAUDE_MODELS, ...localOptions]
  const selected =
    displayModels.find(m => m.id === selectedId) ??
    (s.settings.agentRuntime === 'axel' && s.settings.runtimeModel
      ? toLocalOption({ id: s.settings.runtimeModel })
      : CLAUDE_MODELS[0])

  const onSelectModel = async (id: string) => {
    const m = displayModels.find(x => x.id === id)
    if (!m) return
    setSelectedId(id)
    await s.save(buildSelectionPatch(m))
  }

  const onPullModel = async () => {
    const name = pullName.trim()
    if (!name || pullState === 'pulling') return
    const controller = new AbortController()
    pullAbortRef.current = controller
    setPullState('pulling')
    setPullStatus('starting…')
    setPullCompleted(0)
    setPullTotal(0)
    setPullError(null)
    try {
      await pullOllamaModel(name, ev => {
        if (ev.type === 'progress') {
          setPullStatus(ev.status)
          if (typeof ev.total === 'number')     setPullTotal(ev.total)
          if (typeof ev.completed === 'number') setPullCompleted(ev.completed)
        } else if (ev.type === 'error') {
          setPullError(ev.message)
          setPullState('error')
        } else if (ev.type === 'done') {
          setPullState('success')
        }
      }, controller.signal)
      // Stream may end without a 'done' event if the client aborted; only
      // rescan + commit success when we actually saw success.
      if (pullState !== 'error') {
        await rescanOllama()
        setPullState(prev => prev === 'pulling' ? 'success' : prev)
        setPullName('')
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPullState('idle')
      } else {
        setPullError(err instanceof Error ? err.message : String(err))
        setPullState('error')
      }
    } finally {
      pullAbortRef.current = null
    }
  }

  const onCancelPull = () => {
    pullAbortRef.current?.abort()
  }

  const onSaveKey = async (keyId: string) => {
    const v = keyDraft[keyId]?.trim()
    if (!v) return
    await s.save({ apiKeys: { [keyId]: v } })
    setKeyDraft(d => ({ ...d, [keyId]: '' }))
  }

  const onClearKey = async (keyId: string) => {
    await s.save({ apiKeys: { [keyId]: '' } })
  }

  return (
    <>
      <div className="ax-settings-scrim" onClick={onClose} />
      <aside className="ax-settings" role="dialog" aria-label="Settings">
        <header className="ax-settings-head">
          <div className="ax-settings-title">SETTINGS</div>
          <button className="ax-settings-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <section className="ax-settings-section">
          <h5>Model</h5>
          <p className="ax-settings-hint">
            <code>Claude</code> models run via the bundled Claude CLI and need a Google sign-in below.
            <code>Local</code> models run via Ollama on this machine — no key, no cloud.
          </p>

          <label className="ax-settings-label">Model</label>
          <select
            className="ax-settings-input"
            value={selectedId}
            onChange={e => onSelectModel(e.currentTarget.value)}
            disabled={s.saving}
          >
            {(['Claude', 'Local'] as const).map(group => {
              const rows = displayModels.filter(m => m.group === group)
              if (group === 'Local' && rows.length === 0) {
                return (
                  <optgroup key={group} label={group}>
                    <option value="" disabled>
                      {ollamaStatus === 'loading' ? 'scanning…' : 'no local models found'}
                    </option>
                  </optgroup>
                )
              }
              return (
                <optgroup key={group} label={group}>
                  {rows.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              )
            })}
          </select>
          {ollamaStatus === 'unreachable' && (
            <p className="ax-settings-hint">
              Ollama not reachable at <code>{baseURL || OLLAMA_BASE_URL_PH}</code>.
              Install from <code>ollama.com</code>, run <code>ollama serve</code>,
              then pull a model (e.g. <code>ollama pull llama3.2:3b</code>).
            </p>
          )}
          {ollamaStatus === 'ok' && localOptions.length === 0 && (
            <p className="ax-settings-hint">
              Ollama is running but no models are installed. Use the pull box below.
            </p>
          )}

          {ollamaStatus !== 'unreachable' && (
            <>
              <label className="ax-settings-label">Pull a model</label>
              <div className="ax-key-actions">
                <input
                  className="ax-settings-input compact"
                  value={pullName}
                  onChange={e => setPullName(e.currentTarget.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void onPullModel() }}
                  placeholder="gemma4:12b"
                  disabled={pullState === 'pulling'}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                />
                {pullState === 'pulling' ? (
                  <button className="ax-settings-btn ghost" onClick={onCancelPull}>Cancel</button>
                ) : (
                  <button className="ax-settings-btn" onClick={onPullModel} disabled={!pullName.trim()}>
                    Pull
                  </button>
                )}
              </div>
              {pullState === 'pulling' && (
                <p className="ax-settings-hint">
                  {pullStatus || 'starting…'}
                  {pullTotal > 0 && (
                    <> · {(pullCompleted / 1e9).toFixed(2)} / {(pullTotal / 1e9).toFixed(2)} GB
                       {' '}({Math.floor((pullCompleted / pullTotal) * 100)}%)</>
                  )}
                </p>
              )}
              {pullState === 'success' && (
                <p className="ax-settings-hint">Pulled. The model is now in the dropdown.</p>
              )}
              {pullState === 'error' && pullError && (
                <p className="ax-settings-hint">Pull failed: <code>{pullError}</code></p>
              )}
              <p className="ax-settings-hint">
                Browse models at <code>ollama.com/library</code>.
                Pulls keep running on the server if you close this panel.
              </p>
            </>
          )}

          {selected.needsBaseURL && (
            <>
              <label className="ax-settings-label">Ollama base URL (optional)</label>
              <input
                className="ax-settings-input"
                value={baseURL}
                onChange={e => setBaseURL(e.currentTarget.value)}
                onBlur={() => s.save({ runtimeBaseURL: baseURL })}
                placeholder={selected.baseURLPh}
                inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
              <p className="ax-settings-hint">
                Leave blank for the default <code>{selected.baseURLPh}</code>.
              </p>
            </>
          )}

          {selected.runtime === 'claude-code' && (
            <>
              <label className="ax-settings-label">Effort</label>
              <select
                className="ax-settings-input"
                value={effort}
                onChange={async e => {
                  const v = e.currentTarget.value as EffortLevel | ''
                  setEffort(v)
                  await s.save({ effortLevel: v as EffortLevel })
                }}
                disabled={s.saving}
              >
                <option value="">model default</option>
                {(['low', 'medium', 'high', 'xhigh', 'max'] as Array<EffortLevel>).map(lv => (
                  <option key={lv} value={lv}>{lv}</option>
                ))}
              </select>
            </>
          )}
        </section>

        <section className="ax-settings-section">
          <h5>Permissions</h5>
          <p className="ax-settings-hint">
            How much agents can do without asking. Stricter modes pause tool calls
            and show an Allow / Deny prompt in the terminal window that requested them.
          </p>
          <select
            className="ax-settings-input"
            value={s.settings.permissionMode ?? 'default'}
            onChange={e => s.save({ permissionMode: e.currentTarget.value as PermissionMode })}
            disabled={s.saving}
          >
            <option value="default">Ask before changes (safest)</option>
            <option value="acceptEdits">Auto-accept file edits</option>
            <option value="bypassPermissions">Allow everything (no prompts)</option>
          </select>
        </section>

        {selected.auth === 'claude-oauth' && (claude.status !== 'logged-in' || s.hasKeys.anthropic) && (
        <section className="ax-settings-section">
          <h5>Anthropic key (advanced)</h5>
          <p className="ax-settings-hint">
            {claude.status === 'logged-in' && s.hasKeys.anthropic
              ? <>A saved <code>anthropic</code> key overrides the Google sign-in below. Clear it to use OAuth.</>
              : <>Optional: paste an Anthropic key to bypass OAuth. Stored at <code>/data/settings.json</code> and never sent back to the browser.</>}
          </p>
          <div className="ax-key-row">
            <div className="ax-key-name">anthropic</div>
            <div className="ax-key-status">
              {s.hasKeys.anthropic
                ? <span className="set">SET · ••••</span>
                : <span className="unset">not set</span>}
            </div>
            <div className="ax-key-actions">
              <input
                className="ax-settings-input compact"
                type="password"
                value={keyDraft.anthropic ?? ''}
                onChange={e => setKeyDraft(d => ({ ...d, anthropic: e.currentTarget.value }))}
                placeholder={s.hasKeys.anthropic ? 'replace…' : 'paste key'}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
              <button className="ax-settings-btn" onClick={() => onSaveKey('anthropic')} disabled={!keyDraft.anthropic}>
                Save
              </button>
              {s.hasKeys.anthropic && (
                <button className="ax-settings-btn ghost" onClick={() => onClearKey('anthropic')}>Clear</button>
              )}
            </div>
          </div>
        </section>
        )}

        {selected.auth === 'claude-oauth' && (
        <section className="ax-settings-section">
          <h5>Claude account</h5>
          {claude.status === 'loading' && <p className="ax-settings-hint">Checking…</p>}
          {claude.status === 'logged-in' && (
            <>
              <p className="ax-settings-hint">Signed in as <strong>{claude.email ?? 'unknown'}</strong></p>
              <button className="ax-settings-btn ghost" onClick={claude.logout}>Sign out</button>
            </>
          )}
          {claude.status === 'logged-out' && (
            <>
              <p className="ax-settings-hint">Sign in with Google through the Claude OAuth flow.</p>
              <button className="ax-settings-btn primary" onClick={claude.startLogin} disabled={claude.busy}>
                {claude.busy ? 'Starting…' : 'Sign in with Google'}
              </button>
            </>
          )}
          {claude.status === 'awaiting-callback' && (
            <>
              <p className="ax-settings-hint">Open the link → sign in → copy the code → paste it back.</p>
              {claude.loginUrl && (
                <a className="ax-settings-link" href={claude.loginUrl} target="_blank" rel="noreferrer">
                  Open Claude OAuth ↗
                </a>
              )}
              <input
                className="ax-settings-input"
                value={claude.callbackInput}
                onChange={e => claude.setCallbackInput(e.currentTarget.value)}
                placeholder="paste auth code"
                autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
              />
              <button className="ax-settings-btn primary" onClick={claude.completeLogin} disabled={claude.busy || !claude.callbackInput}>
                {claude.busy ? 'Verifying…' : 'Complete sign-in'}
              </button>
            </>
          )}
        </section>
        )}

        <section className="ax-settings-section">
          <h5>Voice</h5>

          {/* TTS Provider */}
          <label className="ax-settings-label">TTS provider</label>
          <div className="ax-voice-switch">
            {([
              ['browser', 'Browser'],
              ['piper', 'Piper'],
              ['kokoro', 'Kokoro'],
            ] as Array<[TtsProvider, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`ax-voice-btn${ttsProvider === id ? ' is-active' : ''}`}
                onClick={() => setTtsProvider(id)}
              >{label}</button>
            ))}
          </div>
          {ttsProvider === 'browser' && (
            <p className="ax-settings-hint">
              Uses your browser's built-in voices via the Web Speech API. Fully zero-setup,
              nothing runs on the server.
            </p>
          )}
          {ttsProvider === 'piper' && (
            <p className="ax-settings-hint">
              Server-side Piper — fully local, fast CPU synthesis. Requires <code>pip install
              piper-tts</code> and voices in <code>python/models/piper/</code>.
            </p>
          )}
          {ttsProvider === 'kokoro' && (
            <p className="ax-settings-hint">
              Server-side Kokoro-82M (onnx) — fully local, best local quality but slower (model
              loads per request). Requires <code>pip install kokoro-onnx soundfile</code> and
              model files in <code>python/models/kokoro/</code>.
            </p>
          )}

          {/* Voice name preference (Ava / Andrew) */}
          <label className="ax-settings-label">Voice preference</label>
          <div className="ax-voice-switch">
            {(['ava', 'andrew'] as Array<TtsVoice>).map(v => (
              <button
                key={v}
                type="button"
                className={`ax-voice-btn${voice === v ? ' is-active' : ''}`}
                onClick={() => setVoice(v)}
              >{v}</button>
            ))}
          </div>

          {/* Clickable browser voice list — only shown when browser provider is active */}
          {ttsProvider === 'browser' && (
            <>
              <label className="ax-settings-label">
                Pick a voice {browserVoices && browserVoices.length === 0 ? '(loading…)' : ''}
              </label>
              {browserVoices && browserVoices.length > 0 ? (
                <div style={{ maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {browserVoices.map(bv => {
                    const isSelected = selectedBrowserVoice
                      ? bv.name === selectedBrowserVoice
                      : bv.name.toLowerCase().includes(voice === 'andrew' ? 'andrew' : 'ava')
                    return (
                      <button
                        key={bv.name}
                        type="button"
                        onClick={() => setSelectedBrowserVoice(bv.name)}
                        style={{
                          textAlign: 'left',
                          background: isSelected ? 'rgba(201,255,46,.1)' : 'rgba(255,255,255,.02)',
                          border: isSelected ? '1px solid rgba(201,255,46,.4)' : '1px solid rgba(255,255,255,.06)',
                          borderRadius: 5,
                          padding: '6px 9px',
                          cursor: 'pointer',
                          color: isSelected ? 'var(--lime)' : 'var(--dim)',
                          fontFamily: 'var(--mono)',
                          fontSize: 10.5,
                        }}
                      >
                        {bv.name}
                        <span style={{ color: 'var(--dimmer)', marginLeft: 8, fontSize: 9 }}>{bv.lang}</span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="ax-settings-hint">No voices found — Chrome must load them on first page interaction. Try tapping the orb and opening settings again.</p>
              )}
              {selectedBrowserVoice && (
                <button
                  className="ax-settings-btn ghost"
                  onClick={() => setSelectedBrowserVoice(null)}
                  style={{ alignSelf: 'flex-start', fontSize: 10 }}
                >
                  Reset to auto ({voice})
                </button>
              )}
            </>
          )}
        </section>

        <section className="ax-settings-section">
          <h5>Project directory</h5>
          <p className="ax-settings-hint">Axel runs in this directory. All subdirectories appear as nodes in the graph.</p>
          <code className="ax-code">{s.projectsRoot ?? '— default —'}</code>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="ax-settings-btn primary" onClick={() => setBrowseOpen(true)}>
              📁 Browse…
            </button>
            {s.settings.projectsRoot && (
              <button className="ax-settings-btn ghost" disabled={s.saving}
                onClick={async () => { await s.save({ projectsRoot: '' }); onProjectsRefresh() }}>
                Reset to default
              </button>
            )}
            <button className="ax-settings-btn ghost" onClick={onProjectsRefresh}>Re-scan</button>
          </div>

          {browseOpen && (
            <DirBrowser
              initialPath={s.projectsRoot ?? s.settings.projectsRoot ?? '/'}
              saving={s.saving}
              onSelect={selectDir}
              onClose={() => setBrowseOpen(false)}
            />
          )}
        </section>

        <PairPhone />

        <section className="ax-settings-section">
          <h5>MCP servers</h5>
          <p className="ax-settings-hint">Drop server registration JSON files here:</p>
          <code className="ax-code">{s.mcpRegistryDir || '— unknown —'}</code>
          <button className="ax-settings-btn ghost" onClick={onMcpRefresh}>Reload MCP registry</button>
        </section>

        <footer className="ax-settings-foot">
          <span>axel · network controller</span>
        </footer>
      </aside>
    </>
  )
}
