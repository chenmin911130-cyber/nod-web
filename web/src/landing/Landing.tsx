import { lazy, Suspense, useEffect, useState } from 'react'
import { fetchMe } from '../auth'
import './Landing.css'

const GoogleButton = lazy(() => import('../site/ClerkAuth').then((m) => ({ default: m.GoogleButton })))

type ConsoleMode = 'interview' | 'meeting' | 'translate'

const MODES: Record<
  ConsoleMode,
  { label: string; hear: string; live: string; answerLabel: string; answer: string }
> = {
  interview: {
    label: 'INTERVIEW · AUTO',
    hear: '“Walk me through a time you solved a hard problem.”',
    live: 'Matching language… English question, English answer.',
    answerLabel: 'SPEAKABLE ANSWER',
    answer: 'Lead with the result, then one project: the judgment, the action, and the impact.',
  },
  meeting: {
    label: 'MEETING · LIVE TRANSCRIPT',
    hear: '“Let’s kick off the customer pilot on Tuesday.”',
    live: 'Flagged: customer pilot / Tuesday / owner TBD',
    answerLabel: 'MINUTES',
    answer: 'Confirm the start date. Next: name an owner and send the prep list. Export as PDF.',
  },
  translate: {
    label: 'TRANSLATE · EN → CH',
    hear: '“Let’s make the next step clear for everyone.”',
    live: '让我们把下一步向所有人说明清楚。',
    answerLabel: 'CAPTION',
    answer: 'Nine target languages. Queue, retry, or pass through if it is already in the target language.',
  },
}

function NodLogo() {
  return (
    <svg className="brand-mark" width="27" height="27" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path
        d="M26 88 V32 A13 13 0 0 1 52 32 L78 58"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M58 38 Q66 29 81 34 V60" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
      <circle cx="81" cy="70" r="4.5" fill="#5bdaf4" />
    </svg>
  )
}

export default function Landing({ clerkEnabled = false }: { clerkEnabled?: boolean }) {
  const [mode, setMode] = useState<ConsoleMode>('interview')
  const [navOpen, setNavOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const demo = MODES[mode]
  const primaryHref = signedIn ? '/app' : '/signup'
  const primaryLabel = signedIn ? 'Enter workspace' : 'Start free trial'

  useEffect(() => {
    document.title = 'Nod — AI Notes, Live Transcription & Translation'
    void fetchMe().then((me) => setSignedIn(Boolean(me)))
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) entry.target.classList.add('visible')
        }
      },
      { threshold: 0.12 },
    )
    document.querySelectorAll('.nod-landing .reveal').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  const closeNav = () => setNavOpen(false)

  return (
    <div className="nod-landing">
      <header className={`site-header${navOpen ? ' nav-open' : ''}`}>
        <div className="shell header-inner">
          <a className="brand" href="#top" onClick={closeNav}>
            <NodLogo />
            Nod
          </a>
          <nav className="desktop-nav">
            <a href="#workspaces" onClick={closeNav}>
              Workspaces
            </a>
            <a href="#use-cases" onClick={closeNav}>
              Use cases
            </a>
            <a href="#pilot" onClick={closeNav}>
              Pricing
            </a>
            <a href="#privacy-trust" onClick={closeNav}>
              Privacy
            </a>
          </nav>
          <div className="header-actions">
            {signedIn ? (
              <a className="button button-ghost" href="/account">
                Account
              </a>
            ) : (
              <a className="button button-ghost" href="/login">
                Sign in
              </a>
            )}
            <a className="button button-primary" href={primaryHref}>
              {primaryLabel}
            </a>
            <button
              className="mobile-toggle"
              type="button"
              aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={navOpen}
              onClick={() => setNavOpen((open) => !open)}
            >
              {navOpen ? '×' : '≡'}
            </button>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="shell hero-grid">
            <div className="reveal visible">
              <div className="hero-eyebrow-row">
                <div className="eyebrow">Your AI listening companion.</div>
                <span className="brand-chip">Listen · Note · Translate</span>
              </div>
              <h1>
                Listen, take notes, and translate conversations in real time —{' '}
                <span className="underline">without interrupting your workflow.</span>
              </h1>
              <p className="hero-tagline">Hear it. Keep it. Speak the next line.</p>
              <p className="hero-copy">
                Nod is a live voice workspace — not a passive transcript. Interview, Meeting, and
                Translate share one window: live transcription with AssemblyAI, AI notes and answers
                with DeepSeek.
              </p>
              <div className="hero-actions">
                {clerkEnabled && !signedIn ? (
                  <Suspense fallback={null}>
                    <GoogleButton next="/app" />
                  </Suspense>
                ) : null}
                <a className="button button-primary" href={primaryHref}>
                  {primaryLabel}
                </a>
                <a className="button button-ghost" href="#demo">
                  See how it works ↓
                </a>
              </div>
              <div className="signal-row">
                <span>
                  <i className="dot" />
                  Explore the demo
                </span>
                <span>→ Try free trial</span>
                <span>→ Save your history</span>
              </div>
            </div>

            <div
              id="demo"
              className="live-console reveal visible"
              aria-label="Interactive Nod workspace preview — click Interview, Meeting, or Translate"
            >
              <div className="console-preview-label">
                <span className="mono">PRODUCT PREVIEW</span>
                <span className="tab-hint">Click a mode to explore</span>
              </div>
              <div className="console-top">
                <div className="workspace-tabs" role="tablist" aria-label="Workspace modes">
                  {(['interview', 'meeting', 'translate'] as const).map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={mode === id}
                      aria-controls={`console-panel-${id}`}
                      className={mode === id ? 'active' : ''}
                      onClick={() => setMode(id)}
                    >
                      {id[0].toUpperCase() + id.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="window-controls">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="console-main">
                <aside className="console-rail">
                  <div className="mic">⌁</div>
                  <div className="rail-line" />
                  <div className="rail-text">LISTENING</div>
                </aside>
                <div className="console-content" id={`console-panel-${mode}`} role="tabpanel">
                  <div className="console-mode">{demo.label}</div>
                  <div className="caption">
                    <b>YOU HEAR</b>
                    <span>{demo.hear}</span>
                  </div>
                  <div className="caption muted">
                    <b>LIVE</b>
                    <span>{demo.live}</span>
                  </div>
                  <div className="answer">
                    <small>{demo.answerLabel}</small>
                    {demo.answer}
                  </div>
                  <div className="live-bar" />
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="proof">
          <div className="shell proof-inner">
            <p className="mono">BUILT FOR MOMENTS THAT MATTER</p>
            <div className="proof-list">
              <span>Live transcript</span>
              <span>Speakable answers</span>
              <span>Nine languages</span>
              <span>Copy and PDF export</span>
            </div>
          </div>
        </div>

        <section className="problem">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">WHY NOD / 02</div>
              <h2>
                You do not need more tools.
                <br />
                You need a way to not lose the room.
              </h2>
              <p>
                Interviews, client calls, and cross-language meetings move faster than notes. Nod turns
                speech into a line you can keep, answer, or caption — while the conversation is still
                happening.
              </p>
            </div>
            <div className="problem-grid reveal">
              <article className="problem-card">
                <span className="index">01 / PREPARE</span>
                <h3>Practice should not be a guess</h3>
                <p>
                  Hear the question, then speak a structured answer. Auto matches language: English in,
                  English out. Chinese in, Chinese out.
                </p>
              </article>
              <article className="problem-card">
                <span className="index">02 / REMEMBER</span>
                <h3>Meetings should not live in memory</h3>
                <p>
                  Keep the transcript, flag actions, and leave with a summary you can print or save as
                  PDF.
                </p>
              </article>
              <article className="problem-card">
                <span className="index">03 / UNDERSTAND</span>
                <h3>Language should not stall the next line</h3>
                <p>
                  Live captions in the language you need, with a queue, retry, and passthrough when the
                  line is already there.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="workspaces" id="workspaces">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">THREE WORKSPACES / 03</div>
              <h2>
                Not three scattered tools.
                <br />
                One continuous voice workspace.
              </h2>
              <p>
                Interview, Meeting, and Translate share the same live window, shortcuts, and history. Switch
                the mode. Keep listening.
              </p>
            </div>
            <div className="workspace-grid">
              <article className="work-card interview reveal">
                <div className="card-top">
                  <span className="mode-symbol">⌁</span>
                  <span className="tag">INTERVIEW</span>
                </div>
                <h3>Interview</h3>
                <p>Hear the question. Stream an answer you can speak aloud.</p>
                <ul className="feature-list">
                  <li>Auto language matching</li>
                  <li>F2 record · F3 listen · F4 clear</li>
                  <li>Copy the latest answer</li>
                </ul>
              </article>
              <article className="work-card meeting reveal">
                <div className="card-top">
                  <span className="mode-symbol">≋</span>
                  <span className="tag">MEETING</span>
                </div>
                <h3>Meeting</h3>
                <p>Keep the room on a timeline, then leave with minutes you can act on.</p>
                <ul className="feature-list">
                  <li>Live transcript</li>
                  <li>Action flags</li>
                  <li>Summary and PDF / print</li>
                </ul>
              </article>
              <article className="work-card translate reveal">
                <div className="card-top">
                  <span className="mode-symbol">文</span>
                  <span className="tag">TRANSLATE</span>
                </div>
                <h3>Translate</h3>
                <p>Captions while the other language is still in the air.</p>
                <ul className="feature-list">
                  <li>Chinese, Japanese, Korean, English</li>
                  <li>Italian, Spanish, French, German, Portuguese</li>
                  <li>Queue, retry, passthrough</li>
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section className="use-cases" id="use-cases">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">USE CASES / 04</div>
              <h2>Built for the conversations you cannot pause.</h2>
              <p>
                Whether you are in a lecture hall, a client call, or a bilingual stand-up, Nod keeps
                the line on screen while you stay in the room.
              </p>
            </div>
            <div className="use-case-grid reveal">
              <article className="use-case-card">
                <span className="use-case-icon">⌁</span>
                <h3>For students</h3>
                <p>
                  Follow lectures in real time, capture auto notes, and spend less energy typing
                  every sentence. Review speakable summaries before exams.
                </p>
              </article>
              <article className="use-case-card">
                <span className="use-case-icon">≋</span>
                <h3>For meetings</h3>
                <p>
                  Stay present in the conversation while Nod keeps a live transcript, flags
                  actions, and drafts minutes you can export as PDF.
                </p>
              </article>
              <article className="use-case-card">
                <span className="use-case-icon">文</span>
                <h3>For multilingual work</h3>
                <p>
                  Keep the original speech and live translation together. Nine target languages with
                  queue, retry, and passthrough when the line is already in your language.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="flow">
          <div className="shell flow-layout">
            <div className="flow-copy reveal">
              <div className="eyebrow">HOW IT WORKS / 04</div>
              <h2>
                Hear it.
                <br />
                Get a result you can use.
              </h2>
              <p>
                The point is not more AI talk. It is a line on screen at the moment you need it: an
                answer to speak, a decision to keep, or a caption to follow.
              </p>
            </div>
            <div className="flow-stages reveal">
              <div className="flow-stage">
                <strong>01</strong>
                <div>
                  <h3>Capture audio</h3>
                  <p>Browser microphone, or Windows system audio on desktop.</p>
                </div>
                <span className="arrow">→</span>
              </div>
              <div className="flow-stage">
                <strong>02</strong>
                <div>
                  <h3>Transcribe</h3>
                  <p>Streaming speech-to-text with AssemblyAI Universal 3.5 Pro.</p>
                </div>
                <span className="arrow">→</span>
              </div>
              <div className="flow-stage">
                <strong>03</strong>
                <div>
                  <h3>Generate the result</h3>
                  <p>DeepSeek streams the answer, minutes, or caption into the right pane.</p>
                </div>
                <span className="arrow">→</span>
              </div>
              <div className="flow-stage">
                <strong>04</strong>
                <div>
                  <h3>Keep moving</h3>
                  <p>Copy, export, or keep listening. F2 / F3 / F4 stay the same.</p>
                </div>
                <span className="arrow">↗</span>
              </div>
            </div>
          </div>
        </section>

        <section className="audience" id="who">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">WHO IT IS FOR / 05</div>
              <h2>Built first for bilingual professional talk.</h2>
              <p>
                Start where English and Chinese switch in the same hour. Then carry the same window into
                remote meetings and live interpretation.
              </p>
            </div>
            <div className="audience-grid reveal">
              <article className="audience-main">
                <h3>Bilingual professionals</h3>
                <p>
                  Candidates, students, and cross-border teams who need a speakable answer, a clean
                  record, or a caption without leaving the call.
                </p>
              </article>
              <div className="audience-side">
                <article className="audience-mini">
                  <span>REMOTE WORK</span>
                  <h4>Remote meetings</h4>
                  <p>Keep the transcript and actions instead of rewriting the room afterwards.</p>
                </article>
                <article className="audience-mini">
                  <span>LIVE INTERPRET</span>
                  <h4>Live captions</h4>
                  <p>Follow the other language while you still have a turn to take.</p>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className="commercial" id="pilot">
          <div className="shell commercial-grid">
            <div className="reveal">
              <div className="eyebrow">PILOT / 06</div>
              <h2>
                Prove it in a real conversation.
                <br />
                Then decide if it stays.
              </h2>
              <p>
                Create an account to start a free trial: 20 minutes of live transcription and 100,000 generation
                tokens. Pro is $12 / month with eight hours of transcription. Windows desktop — system audio, pin,
                and minutes — is next.
              </p>
              <div className="checks">
                <div className="check">
                  <i>✓</i>
                  <div>
                    <strong>Usage you can see</strong>
                    <span>Plans will track transcription and generation, not hidden seat math.</span>
                  </div>
                </div>
                <div className="check">
                  <i>✓</i>
                  <div>
                    <strong>Privacy before paid</strong>
                    <span>Recording consent, data notes, and deletion land before commercial plans.</span>
                  </div>
                </div>
                <div className="check">
                  <i>✓</i>
                  <div>
                    <strong>Feedback shapes the queue</strong>
                    <span>Early workflows decide what ships next — not a feature dump.</span>
                  </div>
                </div>
              </div>
            </div>
            <aside className="pricing-note reveal">
              <span className="mono">EARLY ACCESS</span>
              <h3>Start with one real task.</h3>
              <p>
                Run an interview drill, a meeting, or a live caption. Then decide if Nod belongs in the
                next call.
              </p>
              <div className="plan-lines">
                <div>
                  <span>Free trial</span>
                  <b>20 min STT</b>
                </div>
                <div>
                  <span>Pro monthly</span>
                  <b>$12</b>
                </div>
                <div>
                  <span>Hard cost caps</span>
                  <b>Per user / day</b>
                </div>
              </div>
              <a className="button button-primary" href={primaryHref}>
                {signedIn ? 'Enter workspace' : 'Create account'}
              </a>
            </aside>
          </div>
        </section>

        <section className="faq" id="faq">
          <div className="shell faq-grid">
            <div className="reveal">
              <div className="eyebrow">FAQ / 07</div>
              <h2>
                Know what it does.
                <br />
                Know what it does not.
              </h2>
              <p>
                Nod is for preparation, minutes, and captions. Use it inside the rules of the room you
                are in.
              </p>
            </div>
            <div className="faq-list reveal">
              <article className="faq-item">
                <h3>When should I use Interview?</h3>
                <p>
                  For practice and for live questions you want to answer out loud. Follow the
                  interviewer, the platform, and local rules. You stay responsible for what you say.
                </p>
              </article>
              <article className="faq-item">
                <h3>What is the difference between web and desktop?</h3>
                <p>
                  The web app hears your browser microphone. It cannot capture system audio from Zoom or
                  Teams. The Windows desktop can. Pin and stealth are desktop-only.
                </p>
              </article>
              <article className="faq-item">
                <h3>Where does the audio go?</h3>
                <p>
                  Speech is sent to AssemblyAI for transcription and to DeepSeek for answers, minutes,
                  and captions. Consent and deletion will be explicit before paid plans.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="privacy-trust" id="privacy-trust">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">PRIVACY &amp; SECURITY / 08</div>
              <h2>What happens to your audio and transcripts.</h2>
              <p>
                Early product, honest defaults. These are the practices in the live app today — not
                marketing promises we have not shipped.
              </p>
            </div>
            <div className="privacy-grid reveal">
              <article className="privacy-card">
                <h3>Audio is streamed, not stored</h3>
                <p>
                  When you use the workspace, microphone audio is sent to AssemblyAI for live
                  transcription. We do not keep the raw audio file after the session ends.
                </p>
              </article>
              <article className="privacy-card">
                <h3>Transcripts stay on your account</h3>
                <p>
                  Questions, transcripts, answers, summaries, and captions are stored so you can
                  review history — until you delete them from Account.
                </p>
              </article>
              <article className="privacy-card">
                <h3>Encrypted in transit</h3>
                <p>
                  The site and API are served over HTTPS. Session cookies are HTTP-only and marked
                  secure in production.
                </p>
              </article>
              <article className="privacy-card">
                <h3>Third-party processing</h3>
                <p>
                  Speech goes to AssemblyAI. Text may be sent to DeepSeek or OpenRouter for answers,
                  minutes, and captions — under each provider&apos;s own terms.
                </p>
              </article>
              <article className="privacy-card">
                <h3>You can delete your data</h3>
                <p>
                  Delete your account from Account to remove stored history and your login. Copies
                  already processed by speech or model providers cannot be recalled from that screen.
                </p>
              </article>
              <article className="privacy-card">
                <h3>Recording consent</h3>
                <p>
                  You are responsible for consent in the room you are in. Opening the workspace after
                  signup records your agreement to this processing.{' '}
                  <a href="/privacy">Full privacy policy →</a>
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="cta">
          <div className="shell">
            <div className="cta-box reveal">
              <div className="eyebrow">START WITH ONE CONVERSATION</div>
              <h2>
                The next important call
                <br />
                can start with a live window.
              </h2>
              <p>
                You have seen the demo. Start a free trial to open the live workspace — Interview,
                Meeting, and Translate in one window, with history saved to your account.
              </p>
              <div className="cta-actions">
                <a className="button button-primary" href={primaryHref}>
                  {primaryLabel}
                </a>
                {!signedIn && (
                  <a className="button button-ghost" href="/login">
                    Sign in
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="shell footer-inner">
          <div>
            <a className="brand" href="#top">
              <NodLogo />
              Nod
            </a>
            <p>
              Interview · Meeting · Translate
              <br />
              © 2026 Nod. Early product.
            </p>
          </div>
          <div className="footer-links">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/signup">Register</a>
            <a href={signedIn ? '/app' : '/login?next=/app'}>Workspace</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
