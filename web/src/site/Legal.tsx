import { useEffect, type ReactNode } from 'react'
import { applySeo, track } from './track'
import './Site.css'
import { PRODUCT_NAME } from '../brand'
import { CONSENT_LEAD, CONSENT_USE, PRIVACY_AUDIO, TERMS_SERVICE } from '../legalCopy'
import { SITE_ORIGIN, siteUrl } from '../siteOrigin'
import NodMark from './NodMark'

function Shell({
  title,
  path,
  description,
  children,
}: {
  title: string
  path: string
  description: string
  children: ReactNode
}) {
  useEffect(() => {
    applySeo({
      title: `${title} — ${PRODUCT_NAME}`,
      description,
      url: siteUrl(path),
      lang: 'en',
      image: `${SITE_ORIGIN}/og.png`,
      robots: 'index,follow',
    })
  }, [description, path, title])
  return (
    <div className="nod-site-page">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="/">
            <NodMark />
            {PRODUCT_NAME}
          </a>
          <div className="header-actions">
            <a className="button button-cyan header-cta" href="/signup">
              Get started
            </a>
          </div>
        </div>
      </header>
      <div className="site-wrap">
        <div className="site-card legal-body">
          <div className="eyebrow">LEGAL</div>
          <h1>{title}</h1>
          {children}
        </div>
      </div>
    </div>
  )
}

export function PrivacyPage() {
  useEffect(() => {
    track('open_privacy')
  }, [])
  return (
    <Shell
      title="Privacy Policy"
      path="/privacy"
      description="How Nodpilot collects account data, audio, and transcripts, and how long History is kept."
    >
      <p>Last updated: 5 September 2026. Nodpilot (“Nodpilot”, “we”) is an early product in free public testing.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Account data: email, name, one-time sign-in codes, and optional Google account id.</li>
        <li>Usage data: session times, workspace mode, estimated transcription seconds, and token counts.</li>
        <li>Content you generate in the product: questions, transcripts, answers, summaries, and captions, stored so you can review history.</li>
        <li>Feedback you send through the product.</li>
      </ul>
      <h2>Audio</h2>
      <p>{PRIVACY_AUDIO}</p>
      <h2>Language models</h2>
      <p>
        Transcripts, questions, and attached text may be sent to DeepSeek or OpenRouter to generate answers, minutes, or captions.
        Those providers process the text under their own terms.
      </p>
      <h2>Consent</h2>
      <p>
        Recording consent is collected the first time you start the microphone. You can read this
        page and the <a href="/consent">consent note</a> before enabling audio.
      </p>
      <h2>Cookies</h2>
      <p>We use an HTTP-only session cookie and an optional local token so you stay signed in.</p>
      <h2>Retention and deletion</h2>
      <p>
        History is kept for 30 days. You can delete a session or your account from Account. That removes stored history and the
        login. Copies already processed by speech or model providers cannot be pulled back from this screen.
      </p>
      <h2>Contact</h2>
      <p>
        Use the feedback form in Account, or email{' '}
        <a href="mailto:hello@nodpilot.com">hello@nodpilot.com</a>.
      </p>
    </Shell>
  )
}

export function TermsPage() {
  return (
    <Shell
      title="Terms of Service"
      path="/terms"
      description="Terms for using Nodpilot during free public testing."
    >
      <p>Last updated: 5 September 2026.</p>
      <h2>The service</h2>
      <p>
        {TERMS_SERVICE}
      </p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>You must have the right to record or transcribe the room you are in. Many places require consent from everyone present.</li>
        <li>
          AI Listening Assistant is for listening, notes, captions, and drafting a spoken answer in the room you are in. You are
          responsible for accuracy and for following the rules of that room.
        </li>
        <li>Do not use Nodpilot to break the law, harass people, or overload the service.</li>
      </ul>
      <h2>Access during testing</h2>
      <p>
        Nodpilot is currently free to use. There is no subscription checkout on the site and no paid plan for sale. We may still pause
        listening or generation if usage is unusually high. If we later offer paid plans, we will say so before you pay.
      </p>
      <h2>Limits</h2>
      <p>
        We may pause or stop a session when usage is unusually high or a global budget is reached. The service is provided as-is
        during early access, without a guaranteed uptime commitment.
      </p>
      <h2>Termination</h2>
      <p>You may delete your account at any time. We may suspend accounts that abuse quota or harm other users.</p>
      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href="mailto:hello@nodpilot.com">hello@nodpilot.com</a>.
      </p>
    </Shell>
  )
}

export function ConsentPage() {
  return (
    <Shell
      title="Recording consent"
      path="/consent"
      description="What you confirm before Nodpilot starts the microphone."
    >
      <p>{CONSENT_LEAD}</p>
      <h2>Before you start recording</h2>
      <ul>
        <li>This confirmation appears the first time you enable the microphone.</li>
        <li>Tell participants you are using a transcription tool, if the law or the room requires it.</li>
        <li>{CONSENT_USE}</li>
        <li>You can withdraw by signing out and deleting your account. That does not erase provider logs they already hold.</li>
      </ul>
      <p>
        Confirming the in-app prompt before the microphone turns on is your recorded consent for that processing.
      </p>
      <a
        className="button button-primary"
        href="/signup"
        onClick={() => track('cta_hero_start', { place: 'consent' })}
      >
        Continue to signup
      </a>
    </Shell>
  )
}
