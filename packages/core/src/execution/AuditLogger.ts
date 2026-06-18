import fs from 'fs'
import path from 'path'

export type AuditEntry = {
  type: 'execute' | 'denied' | 'error'
  sessionId: string
  tool: string
  input: unknown
  reason?: string
}

export class AuditLogger {
  private stream: fs.WriteStream
  private healthy = true

  constructor(logPath: string) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    this.stream = fs.createWriteStream(logPath, { flags: 'a' })
    this.stream.on('error', err => {
      console.error('[AuditLogger] write stream error — logging disabled:', err.message)
      this.healthy = false
    })
  }

  log(entry: AuditEntry): Promise<void> {
    if (!this.healthy) return Promise.reject(new Error('AuditLogger stream is unhealthy'))
    return new Promise((resolve, reject) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
      this.stream.write(line, err => (err ? reject(err) : resolve()))
    })
  }
}
