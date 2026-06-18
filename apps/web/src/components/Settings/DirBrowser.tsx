import { useEffect, useState } from 'react'
import { browseDir } from '../../api.js'

type Props = {
  initialPath: string
  saving: boolean
  onSelect: (path: string) => void
  onClose: () => void
}

// Server-filesystem directory picker — navigates via /api/fs/browse.
export function DirBrowser({ initialPath, saving, onSelect, onClose }: Props) {
  const [path, setPath] = useState<string | null>(null)
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([])
  const [parent, setParent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browseTo = async (targetPath: string) => {
    setLoading(true)
    setError(null)
    try {
      const d = await browseDir(targetPath)
      if (!d.ok) { setError(d.error ?? 'Cannot read this directory'); return }
      setPath(d.path)
      setParent(d.parent)
      setDirs(d.dirs)
    } catch {
      setError('Failed to connect')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { browseTo(initialPath) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      marginTop: '0.75rem', background: '#06090f',
      border: '1px solid #1a2a3a', borderRadius: '8px', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem',
        padding: '0.5rem 0.65rem', borderBottom: '1px solid #0e1a2a',
        background: '#080d18',
      }}>
        <button
          style={{ background: 'none', border: 'none', color: parent ? '#4a7aaa' : '#1a2a3a',
            cursor: parent ? 'pointer' : 'default', fontSize: '0.8rem', padding: '0 0.25rem' }}
          onClick={() => parent && browseTo(parent)}
          disabled={!parent}
          title="Go up"
        >
          ← up
        </button>
        <span style={{ flex: 1, fontSize: '0.65rem', color: '#3a5a7a',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl' }}>
          {path ?? '…'}
        </span>
        <button
          style={{ background: 'none', border: 'none', color: '#2a3a5a', cursor: 'pointer', fontSize: '0.8rem', padding: '0 0.25rem' }}
          onClick={onClose}
          title="Cancel"
        >
          ✕
        </button>
      </div>

      {/* Directory list */}
      <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: '0.75rem 0.65rem', fontSize: '0.72rem', color: '#2a3a5a' }}>Loading…</div>
        )}
        {error && (
          <div style={{ padding: '0.75rem 0.65rem', fontSize: '0.72rem', color: '#f87171' }}>{error}</div>
        )}
        {!loading && !error && dirs.length === 0 && (
          <div style={{ padding: '0.75rem 0.65rem', fontSize: '0.72rem', color: '#2a3a5a' }}>No subdirectories</div>
        )}
        {!loading && dirs.map(d => (
          <button
            key={d.path}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              width: '100%', background: 'none', border: 'none',
              borderBottom: '1px solid #080e1a', padding: '0.45rem 0.65rem',
              color: '#7db0e8', fontSize: '0.78rem', cursor: 'pointer',
              textAlign: 'left',
            }}
            onClick={() => browseTo(d.path)}
          >
            <span style={{ opacity: 0.5, flexShrink: 0 }}>📁</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
            <span style={{ opacity: 0.3, fontSize: '0.65rem', flexShrink: 0 }}>›</span>
          </button>
        ))}
      </div>

      {/* Footer — select current dir */}
      <div style={{ padding: '0.5rem 0.65rem', borderTop: '1px solid #0e1a2a', background: '#080d18' }}>
        <button
          className="ax-settings-btn primary"
          style={{ width: '100%' }}
          disabled={saving || !path}
          onClick={() => path && onSelect(path)}
        >
          {saving ? 'Saving…' : `Select "${path?.split('/').pop() ?? path}"`}
        </button>
      </div>
    </div>
  )
}
