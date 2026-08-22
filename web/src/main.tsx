import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import App from './App'
import LandingPage from './landing/LandingPage'
import { installWebApi } from './bridge'
import './App.css'

function AppRoute() {
  installWebApi()
  return <App />
}

function Root() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/app" element={<AppRoute />} />
        <Route path="/app/*" element={<AppRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<Root />)
}
