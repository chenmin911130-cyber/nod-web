import { createRoot } from 'react-dom/client'
import App from './App'
import { installWebApi } from './bridge'
import './App.css'

installWebApi()

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<App />)
}
