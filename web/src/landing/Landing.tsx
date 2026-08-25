import { useEffect, useRef, useState } from 'react'
import { fetchMe } from '../auth'
import { applySeo, track } from '../site/track'
import { COPY, type Locale } from './copy'
import './Landing.css'

type ConsoleMode = 'interview' | 'meeting' | 'translate'

const MODES: Record<
  ConsoleMode,
  { label: string; hear: string; live: string; answerLabel: string; answer: string }
> = {
  interview: {
    label: 'LISTENING · AUTO',
    hear: '“Walk me through a time you solved a hard problem.”',
    live: 'Matching language… the answer follows the question.',
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
    answer: 'Eight target languages. Queue, retry, or pass through if it is already in the target language.',
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

function DemoVideo({ caption }: { caption: string }) {
  const [ok, setOk] = useState(false)
  return (
    <div className={`demo-video-wrap${ok ? ' on' : ''}`}>
      <video
        className="demo-video"
        src="/demo.mp4"
        poster="/og.png"
        controls
        playsInline
        preload="metadata"
        onLoadedData={() => setOk(true)}
        onError={() => setOk(false)}
      />
      {ok ? <p className="demo-caption">{caption}</p> : null}
    </div>
  )
}

export default function Landing({ locale = 'en' }: { locale?: Locale; clerkEnabled?: boolean }) {
  const [mode, setMode] = useState<ConsoleMode>('interview')
  const [navOpen, setNavOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const priced = useRef(false)
  const t = COPY[locale]
  const demo = MODES[mode]
  const primaryHref = signedIn ? '/app' : '/signup'
  const primaryLabel = signedIn ? t.enterWorkspace : t.startFreeLong
  const home = locale === 'zh' ? '/zh' : '/'

  useEffect(() => {
    const origin = window.location.origin.replace(/\/+$/, '')
    applySeo({
      title: t.title,
      description: t.description,
      ogTitle: t.ogTitle,
      url: origin + (locale === 'zh' ? '/zh' : '/'),
      lang: t.htmlLang,
      image: `${origin}/og.png`,
    })
    void fetchMe().then((me) => setSignedIn(Boolean(me)))
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible')
            if (entry.target.id === 'pilot' && !priced.current) {
              priced.current = true
              track('scroll_pricing')
            }
          }
        }
      },
      { threshold: 0.12 },
    )
    document.querySelectorAll('.nod-landing .reveal, .nod-landing #pilot').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [locale, t.description, t.htmlLang, t.ogTitle, t.title])

  const closeNav = () => setNavOpen(false)
  const onHeroCta = () => track('cta_hero_start', { place: 'hero', signed_in: signedIn })
  const onHeaderCta = () => track('cta_hero_start', { place: 'header' })
  const onPriceCta = () => track('cta_pricing')

  return (
    <div className="nod-landing">
      <header className={`site-header${navOpen ? ' nav-open' : ''}`}>
        <div className="shell header-inner">
          <a className="brand" href={home} onClick={closeNav}>
            <NodLogo />
            Nod
          </a>
          <nav className="desktop-nav">
            <a href="#workspaces" onClick={closeNav}>
              {t.navWorkspaces}
            </a>
            <a href="#who" onClick={closeNav}>
              {t.navWho}
            </a>
            <a href="#pilot" onClick={closeNav}>
              {t.navPricing}
            </a>
            <a href="/privacy" onClick={closeNav}>
              {t.navPrivacy}
            </a>
            <a className="lang-switch" href={t.langSwitchHref} hrefLang={locale === 'zh' ? 'en' : 'zh-Hans'} onClick={closeNav} aria-label={t.langSwitchLabel}>
              {t.langSwitch}
            </a>
          </nav>
          <div className="header-actions">
            <a className="lang-switch header-lang" href={t.langSwitchHref} hrefLang={locale === 'zh' ? 'en' : 'zh-Hans'} aria-label={t.langSwitchLabel}>
              {t.langSwitch}
            </a>
            {signedIn ? (
              <a className="button button-ghost" href="/account">
                {t.navAccount}
              </a>
            ) : (
              <a className="button button-ghost" href="/login">
                {t.navSignIn}
              </a>
            )}
            <a className="button button-primary" href={primaryHref} onClick={onHeaderCta}>
              {signedIn ? t.enterWorkspace : t.startFree}
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
              <div className="eyebrow">{t.eyebrow}</div>
              <h1>
                Hear it.
                <br />
                Keep it.
                <br />
                <span className="underline">Speak the next line.</span>
              </h1>
              <p className="hero-copy">{t.heroCopy}</p>
              <div className="hero-actions">
                <a className="button button-primary" href={primaryHref} onClick={onHeroCta}>
                  {primaryLabel}
                </a>
                <a className="button button-ghost" href="#workspaces">
                  {t.seeHow}
                </a>
              </div>
              {!signedIn && <p className="hero-note">{t.startFreeNote}</p>}
              <div className="signal-row">
                <span>
                  <i className="dot" />
                  {t.step1}
                </span>
                <span>{t.step2}</span>
                <span>{t.step3}</span>
              </div>
            </div>

            <div className="live-console reveal visible" aria-label={t.consoleAria}>
              <div className="console-top">
                <div className="workspace-tabs">
                  {(['interview', 'meeting', 'translate'] as const).map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={mode === id ? 'active' : ''}
                      onClick={() => setMode(id)}
                    >
                      {id === 'interview' ? 'Listening' : id[0].toUpperCase() + id.slice(1)}
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
                <div className="console-content">
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
            <p className="mono">{t.proofKicker}</p>
            <div className="proof-list">
              <span>{t.proof1}</span>
              <span>{t.proof2}</span>
              <span>{t.proof3}</span>
              <span>{t.proof4}</span>
            </div>
          </div>
        </div>

        <section className="problem">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.whyEyebrow}</div>
              <h2>
                {t.whyH2a}
                <br />
                {t.whyH2b}
              </h2>
              <p>{t.whyP}</p>
            </div>
            <div className="problem-grid reveal">
              <article className="problem-card">
                <span className="index">{t.prepIndex}</span>
                <h3>{t.prepH}</h3>
                <p>{t.prepP}</p>
              </article>
              <article className="problem-card">
                <span className="index">{t.rememberIndex}</span>
                <h3>{t.rememberH}</h3>
                <p>{t.rememberP}</p>
              </article>
              <article className="problem-card">
                <span className="index">{t.understandIndex}</span>
                <h3>{t.understandH}</h3>
                <p>{t.understandP}</p>
              </article>
            </div>
          </div>
        </section>

        <section className="workspaces" id="workspaces">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.wsEyebrow}</div>
              <h2>
                {t.wsH2a}
                <br />
                {t.wsH2b}
              </h2>
              <p>{t.wsP}</p>
            </div>
            <DemoVideo caption={t.demoCaption} />
            <div className="workspace-grid">
              <article className="work-card interview reveal">
                <div className="card-top">
                  <span className="mode-symbol">⌁</span>
                  <span className="tag">LISTENING</span>
                </div>
                <h3>AI Listening Assistant</h3>
                <p>{t.interviewP}</p>
                <ul className="feature-list">
                  <li>{t.interviewF1}</li>
                  <li>{t.interviewF2}</li>
                  <li>{t.interviewF3}</li>
                </ul>
              </article>
              <article className="work-card meeting reveal">
                <div className="card-top">
                  <span className="mode-symbol">≋</span>
                  <span className="tag">MEETING</span>
                </div>
                <h3>Meeting</h3>
                <p>{t.meetingP}</p>
                <ul className="feature-list">
                  <li>{t.meetingF1}</li>
                  <li>{t.meetingF2}</li>
                  <li>{t.meetingF3}</li>
                </ul>
              </article>
              <article className="work-card translate reveal">
                <div className="card-top">
                  <span className="mode-symbol">文</span>
                  <span className="tag">TRANSLATE</span>
                </div>
                <h3>Translate</h3>
                <p>{t.translateP}</p>
                <ul className="feature-list">
                  <li>{t.translateF1}</li>
                  <li>{t.translateF2}</li>
                  <li>{t.translateF3}</li>
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section className="flow">
          <div className="shell flow-layout">
            <div className="flow-copy reveal">
              <div className="eyebrow">{t.flowEyebrow}</div>
              <h2>
                {t.flowH2a}
                <br />
                {t.flowH2b}
              </h2>
              <p>{t.flowP}</p>
            </div>
            <div className="flow-stages reveal">
              <div className="flow-stage">
                <strong>01</strong>
                <div>
                  <h3>{t.flow1H}</h3>
                  <p>{t.flow1P}</p>
                </div>
                <span className="arrow">→</span>
              </div>
              <div className="flow-stage">
                <strong>02</strong>
                <div>
                  <h3>{t.flow2H}</h3>
                  <p>{t.flow2P}</p>
                </div>
                <span className="arrow">→</span>
              </div>
              <div className="flow-stage">
                <strong>03</strong>
                <div>
                  <h3>{t.flow3H}</h3>
                  <p>{t.flow3P}</p>
                </div>
                <span className="arrow">→</span>
              </div>
              <div className="flow-stage">
                <strong>04</strong>
                <div>
                  <h3>{t.flow4H}</h3>
                  <p>{t.flow4P}</p>
                </div>
                <span className="arrow">↗</span>
              </div>
            </div>
          </div>
        </section>

        <section className="audience" id="who">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.whoEyebrow}</div>
              <h2>{t.whoH2}</h2>
              <p>{t.whoP}</p>
            </div>
            <div className="audience-grid reveal">
              <article className="audience-main">
                <h3>{t.whoMainH}</h3>
                <p>{t.whoMainP}</p>
              </article>
              <div className="audience-side">
                <article className="audience-mini">
                  <span>{t.whoRemote}</span>
                  <h4>{t.whoRemoteH}</h4>
                  <p>{t.whoRemoteP}</p>
                </article>
                <article className="audience-mini">
                  <span>{t.whoLive}</span>
                  <h4>{t.whoLiveH}</h4>
                  <p>{t.whoLiveP}</p>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className="commercial" id="pilot">
          <div className="shell commercial-grid">
            <div className="reveal">
              <div className="eyebrow">{t.priceEyebrow}</div>
              <h2>
                {t.priceH2a}
                <br />
                {t.priceH2b}
              </h2>
              <p>{t.priceP}</p>
              <p className="desktop-status">{t.desktopNote}</p>
              <div className="checks">
                <div className="check">
                  <i>✓</i>
                  <div>
                    <strong>{t.check1H}</strong>
                    <span>{t.check1P}</span>
                  </div>
                </div>
                <div className="check">
                  <i>✓</i>
                  <div>
                    <strong>{t.check2H}</strong>
                    <span>{t.check2P}</span>
                  </div>
                </div>
                <div className="check">
                  <i>✓</i>
                  <div>
                    <strong>{t.check3H}</strong>
                    <span>{t.check3P}</span>
                  </div>
                </div>
              </div>
            </div>
            <aside className="pricing-note reveal">
              <span className="mono">{t.planKicker}</span>
              <h3>{t.planH}</h3>
              <p>{t.planP}</p>
              <div className="plan-lines">
                <div>
                  <span>{t.planFree}</span>
                  <b>{t.planFreeV}</b>
                </div>
                <div>
                  <span>{t.planPro}</span>
                  <b>{t.planProV}</b>
                </div>
                <div>
                  <span>{t.planLimits}</span>
                  <b>{t.planLimitsV}</b>
                </div>
                <div>
                  <span>{t.planCancel}</span>
                  <b>{t.planCancelV}</b>
                </div>
                <div>
                  <span>{t.planCard}</span>
                  <b>{t.planCardV}</b>
                </div>
                <div>
                  <span>{t.planOver}</span>
                  <b>{t.planOverV}</b>
                </div>
              </div>
              <a className="button button-primary" href={primaryHref} onClick={onPriceCta}>
                {signedIn ? t.enterWorkspace : t.planCta}
              </a>
              <p className="plan-fine">{t.planFine}</p>
            </aside>
          </div>
        </section>

        <section className="faq" id="faq">
          <div className="shell faq-grid">
            <div className="reveal">
              <div className="eyebrow">{t.faqEyebrow}</div>
              <h2>
                {t.faqH2a}
                <br />
                {t.faqH2b}
              </h2>
              <p>{t.faqP}</p>
            </div>
            <div className="faq-list reveal">
              <article className="faq-item">
                <h3>{t.faq1H}</h3>
                <p>{t.faq1P}</p>
              </article>
              <article className="faq-item">
                <h3>{t.faq2H}</h3>
                <p>{t.faq2P}</p>
              </article>
              <article className="faq-item">
                <h3>{t.faq3H}</h3>
                <p>{t.faq3P}</p>
              </article>
              <article className="faq-item">
                <h3>{t.faq4H}</h3>
                <p>{t.faq4P}</p>
              </article>
            </div>
          </div>
        </section>

        <section className="cta">
          <div className="shell">
            <div className="cta-box reveal">
              <div className="eyebrow">{t.ctaEyebrow}</div>
              <h2>
                {t.ctaH2a}
                <br />
                {t.ctaH2b}
              </h2>
              <p>{t.ctaP}</p>
              <div className="cta-actions">
                <a className="button button-primary" href={primaryHref} onClick={() => track('cta_hero_start', { place: 'footer' })}>
                  {primaryLabel}
                </a>
                {!signedIn && (
                  <a className="button button-ghost" href="/login">
                    {t.navSignIn}
                  </a>
                )}
              </div>
              {!signedIn && <p className="hero-note">{t.startFreeNote}</p>}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="shell footer-inner">
          <div>
            <a className="brand" href={home}>
              <NodLogo />
              Nod
            </a>
            <p>
              {t.footerTag}
              <br />
              {t.footerCopy}
            </p>
          </div>
          <div className="footer-links">
            <a href={t.langSwitchHref} hrefLang={locale === 'zh' ? 'en' : 'zh-Hans'}>
              {t.langSwitch}
            </a>
            <a href="/privacy">
              {t.navPrivacy}
            </a>
            <a href="/terms">Terms</a>
            <a href="/signup">{t.footerRegister}</a>
            <a href={signedIn ? '/app' : '/login?next=/app'}>{t.footerWorkspace}</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
