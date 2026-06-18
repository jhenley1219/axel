import { useAuth } from './hooks/useAuth.js'
import { LockScreen } from './components/LockScreen/LockScreen.js'
import { ConstellationView } from './components/Constellation/ConstellationView.js'

const styles: Record<string, React.CSSProperties> = {
  full: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  spinner: { color: '#444', fontSize: '1rem' },
}

export default function App() {
  const { state, onSetup, onAuthenticated } = useAuth()

  if (state === 'loading') {
    return <div style={styles.full}><div style={styles.spinner}>Loading…</div></div>
  }

  if (state === 'needs_setup') {
    return <div style={styles.full}><LockScreen mode="setup" onAuthenticated={onSetup} /></div>
  }

  if (state === 'locked') {
    return <div style={styles.full}><LockScreen mode="login" onAuthenticated={onAuthenticated} /></div>
  }

  return <ConstellationView />
}
