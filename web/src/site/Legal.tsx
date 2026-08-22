import type { ReactNode } from 'react'
import './Site.css'

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="nod-site-page">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="/">
            Nod
          </a>
          <div className="header-actions">
            <a className="button button-ghost" href="/signup">
              Start free trial
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
  return (
    <Shell title="Privacy Policy">
      <p>Last updated: 23 August 2026. Nod Web (“Nod”, “we”) is an early product operated for commercial trial.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Account data: email, name, password hash, plan, and billing identifiers from Stripe if you pay.</li>
        <li>Usage data: session times, workspace mode, estimated transcription seconds, token counts, and cost estimates.</li>
        <li>Content you generate in the product: questions, transcripts, answers, summaries, and captions, stored so you can review history.</li>
        <li>Feedback you send through the product.</li>
      </ul>
      <h2>Audio</h2>
      <p>
        When you use the workspace, microphone audio is streamed to AssemblyAI for transcription. We do not keep the raw audio file
        after the live session. Transcript text may be stored on your account until you delete it.
      </p>
      <h2>Language models</h2>
      <p>
        Transcripts, questions, and attached text may be sent to DeepSeek or OpenRouter to generate answers, minutes, or captions.
        Those providers process the text under their own terms.
      </p>
      <h2>Cookies</h2>
      <p>We use an HTTP-only session cookie and an optional local token so you stay signed in.</p>
      <h2>Retention and deletion</h2>
      <p>
        You can delete your account from Account. That removes stored history and the login. Copies already processed by speech or
        model providers cannot be pulled back from this screen.
      </p>
      <h2>Contact</h2>
      <p>Use the feedback form in Account, or email the address published when a custom domain is live.</p>
    </Shell>
  )
}

export function TermsPage() {
  return (
    <Shell title="Terms of Service">
      <p>Last updated: 23 August 2026.</p>
      <h2>The service</h2>
      <p>
        Nod provides a live voice workspace for interview practice, meeting notes, and captions. It is sold as a trial and a paid
        Pro plan. Features can change while the product is in early access.
      </p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>You must have the right to record or transcribe the room you are in. Many places require consent from everyone present.</li>
        <li>Interview answers are drafts for you to speak. You are responsible for accuracy and for following interviewer and platform rules.</li>
        <li>Do not use Nod to break the law, harass people, or overload the service.</li>
      </ul>
      <h2>Plans and payment</h2>
      <p>
        The free trial includes a monthly transcription and generation cap. Pro raises those caps. If Stripe is connected, paid
        subscriptions renew monthly until you cancel. Usage limits still apply so model cost stays bounded.
      </p>
      <h2>Limits</h2>
      <p>
        We may pause or stop a session when you hit a plan cap, a daily cost cap, or a global budget. The service is provided as-is
        during early access, without a guaranteed uptime commitment.
      </p>
      <h2>Termination</h2>
      <p>You may delete your account at any time. We may suspend accounts that abuse quota or harm other users.</p>
    </Shell>
  )
}

export function ConsentPage() {
  return (
    <Shell title="Recording consent">
      <p>
        Nod listens through your browser microphone (web) or system audio (Windows desktop). Speech is sent to AssemblyAI. Text may
        be sent to a language model. Other people in the call may not know you are transcribing unless you tell them.
      </p>
      <h2>Before you start</h2>
      <ul>
        <li>Tell participants you are using a transcription tool, if the law or the room requires it.</li>
        <li>Do not use Interview as a hidden prompt in a live interview if that violates the employer’s rules.</li>
        <li>You can withdraw by signing out and deleting your account. That does not erase provider logs they already hold.</li>
      </ul>
      <p>
        Opening the workspace after signup, or ticking the box on create-account, is your recorded consent for that processing.
      </p>
      <a className="button button-primary" href="/signup">
        Continue to signup
      </a>
    </Shell>
  )
}
