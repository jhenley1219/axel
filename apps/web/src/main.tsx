import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'

// TEMP: window-resize diagnostics — remove with src/debug/ when done
if (import.meta.env.DEV) {
  void import('./debug/pointerLog.js').then(m => m.installPointerLog())
}

const el = document.getElementById('root')!
createRoot(el).render(<StrictMode><App /></StrictMode>)
