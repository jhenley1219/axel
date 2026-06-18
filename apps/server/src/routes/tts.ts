import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import path from 'path'
import { readFile, unlink, writeFile } from 'fs/promises'
import { Router } from 'express'
import { sessionGuard } from '../middleware/sessionGuard.js'
import { config } from '../config.js'

const execFileAsync = promisify(execFile)

const PYTHON = config.pythonPath
const MODELS_DIR = path.join(config.pythonScriptDir, 'models')

type EngineSpec = {
  voices: Record<string, string>
  mime: string
  ext: string
  timeoutMs: number
  args: (input: { voiceName: string; text: string; textFile: string; outFile: string }) => Array<string>
}

// Local-only engines on purpose: no cloud TTS APIs, so a public deployment
// can't rack up third-party usage on the host's behalf.
const ENGINES: Record<string, EngineSpec> = {
  piper: {
    voices: { ava: 'en_US-amy-medium', andrew: 'en_US-ryan-medium' },
    mime: 'audio/wav',
    ext: 'wav',
    timeoutMs: 30_000,
    // piper has no --text flag — it reads from stdin or an input file
    args: ({ voiceName, textFile, outFile }) =>
      ['-m', 'piper', '-m', path.join(MODELS_DIR, 'piper', `${voiceName}.onnx`), '-i', textFile, '-f', outFile],
  },
  kokoro: {
    voices: { ava: 'af_heart', andrew: 'am_michael' },
    mime: 'audio/wav',
    ext: 'wav',
    // each request loads the 310MB onnx model from scratch — slow first token
    timeoutMs: 60_000,
    args: ({ voiceName, text, outFile }) => [
      path.join(config.pythonScriptDir, 'kokoro_tts.py'),
      '--model-dir', path.join(MODELS_DIR, 'kokoro'),
      '--voice', voiceName,
      '--text', text,
      '--output', outFile,
    ],
  },
}

export const ttsRouter = Router()

ttsRouter.post('/tts/synthesize', sessionGuard, async (req, res) => {
  const { text, voice = 'ava', provider = 'piper' } = req.body as { text?: string; voice?: string; provider?: string }
  if (!text?.trim()) { res.status(400).json({ error: 'no_text' }); return }

  const engine = ENGINES[provider] ?? ENGINES.piper
  const voiceName = engine.voices[voice] ?? engine.voices.ava
  const id = randomUUID()
  const outFile = path.join(tmpdir(), `axel-tts-${id}.${engine.ext}`)
  const textFile = path.join(tmpdir(), `axel-tts-${id}.txt`)

  try {
    await writeFile(textFile, text.trim())
    await execFileAsync(
      PYTHON,
      engine.args({ voiceName, text: text.trim(), textFile, outFile }),
      { timeout: engine.timeoutMs },
    )

    const audio = await readFile(outFile)
    res.set('Content-Type', engine.mime)
    res.send(audio)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tts] synthesis error:', msg)
    res.status(500).json({ error: 'synthesis_failed', detail: msg.slice(0, 500) })
  } finally {
    await unlink(outFile).catch(() => {})
    await unlink(textFile).catch(() => {})
  }
})
