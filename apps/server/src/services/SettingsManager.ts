import { readFile, writeFile, mkdir } from 'fs/promises'
import path from 'path'
import type { AppSettings } from '@axel/core'
import { config } from '../config.js'

const resolveSettingsPath = (): string =>
  process.env.SETTINGS_PATH ?? path.join(path.dirname(config.auditLogPath), '..', 'settings.json')

export class SettingsManager {
  private cache: AppSettings = {}

  private get settingsPath(): string {
    return resolveSettingsPath()
  }

  async getSettings(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.settingsPath, 'utf-8')
      this.cache = JSON.parse(raw) as AppSettings
    } catch { this.cache = {} }
    return this.cache
  }

  // Synchronous accessor for hot paths (per-call provider/runtime selection).
  // Returns the most recently loaded settings, or {} if never loaded.
  getCachedSettings(): AppSettings {
    return this.cache
  }

  async updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.getSettings()
    const next: AppSettings = { ...current, ...partial }
    // Empty string means "clear / use default" for string fields
    if (partial.projectsRoot === '') delete next.projectsRoot
    if ((partial.effortLevel as string | undefined) === '') delete next.effortLevel
    if (partial.apiKeys) {
      next.apiKeys = { ...(current.apiKeys ?? {}), ...partial.apiKeys }
      for (const [k, v] of Object.entries(next.apiKeys)) {
        if (v === '' || v === null) delete next.apiKeys[k]
      }
    }
    await this.write(next)
    this.cache = next
    return next
  }

  // Keys must never leave the server in any form — clients get only the
  // hasKeys boolean flags alongside this payload.
  getRedactedSettings(s: AppSettings): AppSettings {
    const redacted = { ...s }
    delete redacted.apiKeys
    return redacted
  }

  private async write(s: AppSettings): Promise<void> {
    const p = this.settingsPath
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(s, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }
}
