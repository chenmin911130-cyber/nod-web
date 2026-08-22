import { lazy, Suspense } from 'react'
import Landing from '../landing/Landing'
import AccountPage from './Account'
import { ForgotPage, LoginPage, ResetPage, SignupPage } from './AuthPages'
import { ConsentPage, PrivacyPage, TermsPage } from './Legal'
import '../landing/Landing.css'

const ClerkChrome = lazy(() => import('./ClerkAuth').then((m) => ({ default: m.ClerkChrome })))
const SSOCallbackPage = lazy(() => import('./ClerkAuth').then((m) => ({ default: m.SSOCallbackPage })))

export default function Site({ clerkEnabled = false }: { clerkEnabled?: boolean }) {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  const page =
    path === '/login' ? (
      <LoginPage clerkEnabled={clerkEnabled} />
    ) : path === '/signup' ? (
      <SignupPage clerkEnabled={clerkEnabled} />
    ) : path === '/sso-callback' ? (
      clerkEnabled ? (
        <Suspense fallback={<div className="nod-site-page" />}>
          <SSOCallbackPage />
        </Suspense>
      ) : (
        <LoginPage />
      )
    ) : path === '/forgot' ? (
      <ForgotPage />
    ) : path === '/reset' ? (
      <ResetPage />
    ) : path === '/account' ? (
      <AccountPage />
    ) : path === '/privacy' ? (
      <PrivacyPage />
    ) : path === '/terms' ? (
      <TermsPage />
    ) : path === '/consent' ? (
      <ConsentPage />
    ) : (
      <Landing clerkEnabled={clerkEnabled} />
    )

  if (!clerkEnabled) return page
  return (
    <>
      <Suspense fallback={null}>
        <ClerkChrome />
      </Suspense>
      {page}
    </>
  )
}
