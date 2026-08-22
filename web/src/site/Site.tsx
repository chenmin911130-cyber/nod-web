import Landing from '../landing/Landing'
import AccountPage from './Account'
import { ForgotPage, LoginPage, ResetPage, SignupPage } from './AuthPages'
import { ConsentPage, PrivacyPage, TermsPage } from './Legal'
import '../landing/Landing.css'

export default function Site() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  if (path === '/login') return <LoginPage />
  if (path === '/signup') return <SignupPage />
  if (path === '/forgot') return <ForgotPage />
  if (path === '/reset') return <ResetPage />
  if (path === '/account') return <AccountPage />
  if (path === '/privacy') return <PrivacyPage />
  if (path === '/terms') return <TermsPage />
  if (path === '/consent') return <ConsentPage />
  return <Landing />
}
