import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, SettingsResponse } from '@axel/core'
import { getSettings } from '../api.js'

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>({})
  const [hasKeys, setHasKeys] = useState<Record<string, boolean>>({})
  const [projectsRoot, setProjectsRoot] = useState<string | null>(null)
  const [mcpRegistryDir, setMcpRegistryDir] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const d = await getSettings()
      if (d?.ok) {
        setSettings(d.settings)
        setHasKeys(d.hasKeys)
        setProjectsRoot(d.projectsRoot)
        setMcpRegistryDir(d.mcpRegistryDir)
      }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const save = useCallback(async (patch: Partial<AppSettings>) => {
    setSaving(true)
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(patch),
      })
      const d = await r.json() as SettingsResponse
      if (d.ok) { setSettings(d.settings) }
      await refresh()
    } finally { setSaving(false) }
  }, [refresh])

  return { settings, hasKeys, projectsRoot, mcpRegistryDir, loading, saving, refresh, save }
}
