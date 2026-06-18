import { useState, useEffect } from 'react'
import { getAuthStatus } from '../api.js'

export type AuthState = 'loading' | 'needs_setup' | 'locked' | 'authenticated'

export function useAuth() {
  const [state, setState] = useState<AuthState>('loading')

  useEffect(() => {
    getAuthStatus()
      .then(s => {
        if (s.authenticated) setState('authenticated')
        else if (!s.setup) setState('needs_setup')
        else setState('locked')
      })
      .catch(() => setState('locked'))
  }, [])

  const onSetup = () => setState('authenticated')
  const onAuthenticated = () => setState('authenticated')

  return { state, onSetup, onAuthenticated }
}
