import { useEffect, useRef, useState } from 'react'
import { fetchMe } from '../auth'
import { applySeo, track } from '../site/track'
import { COPY, type Locale } from './copy'
import './Landing.css'

type AskId = '1' | '2' | '3' | '4'
type NoteKind = 'meeting' | 'lecture'

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

export default function Landing({ locale = 'en' }: { locale?: Locale; clerkEnabled?: boolean }) {
  const [ask, setAsk] = useState<AskId>('1')
  const [noteKind, setNoteKind] = useState<NoteKind>('meeting')
  const [navOpen, setNavOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const priced = useRef(false)
  const t = COPY[locale]
  const primaryHref = signedIn ? '/app' : '/signup'
  const primaryLabel = signedIn ? t.enterWorkspace : t.startFree
  const home = locale === 'zh' ? '/zh' : '/'
  const askMap = {
    '1': { q: t.ask1, a: t.askA1 },
    '2': { q: t.ask2, a: t.askA2 },
    '3': { q: t.ask3, a: t.askA3 },
    '4': { q: t.ask4, a: t.askA4 },
  } as const

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
            <a href="#live" onClick={closeNav}>
              {t.navHow}
            </a>
            <a href="#situations" onClick={closeNav}>
              {t.navSituations}
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
        <section className="hero hero-value">
          <div className="shell hero-center reveal visible">
            <p className="hero-brand">{t.heroBrand}</p>
            <div className="eyebrow">{t.heroProduct}</div>
            <h1>
              {t.heroH1a}
              <br />
              {t.heroH1b}
              <br />
              <span className="underline">{t.heroH1c}</span>
            </h1>
            <p className="hero-copy">{t.heroCopy}</p>
            <div className="hero-actions">
              <a className="button button-primary" href={primaryHref} onClick={onHeroCta}>
                {primaryLabel}
              </a>
              <a className="button button-ghost" href="#desktop">
                {t.downloadDesktop}
              </a>
            </div>
            {!signedIn && <p className="hero-note">{t.startFreeNote}</p>}
            <div className="hero-proof">
              <span>{t.proof1}</span>
              <span>{t.proof2}</span>
              <span>{t.proof3}</span>
              <span>{t.proof4}</span>
              <span>{t.proof5}</span>
            </div>
          </div>
        </section>

        <section className="live-now" id="live">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.liveEyebrow}</div>
              <h2>{t.liveH}</h2>
              <p>{t.liveP}</p>
            </div>
            <div className="live-split reveal" aria-label={t.consoleAria}>
              <article>
                <span className="pane-kicker">{t.liveLeft}</span>
                <strong>{t.liveWho}</strong>
                <p>{t.liveLine}</p>
              </article>
              <article>
                <span className="pane-kicker">{t.liveRight}</span>
                <strong>{t.liveWho}</strong>
                <p>{t.liveTr}</p>
              </article>
            </div>
          </div>
        </section>

        <section className="ask-now">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.askEyebrow}</div>
              <h2>{t.askH}</h2>
              <p>{t.askP}</p>
            </div>
            <div className="ask-board reveal">
              <div className="ask-chips">
                {(['1', '2', '3', '4'] as const).map((id) => (
                  <button key={id} type="button" className={ask === id ? 'on' : ''} onClick={() => setAsk(id)}>
                    {askMap[id].q}
                  </button>
                ))}
              </div>
              <div className="ask-reply">
                <small>NOD</small>
                <p>{askMap[ask].a}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="notes-now">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.notesEyebrow}</div>
              <h2>{t.notesH}</h2>
              <p>{t.notesP}</p>
            </div>
            <div className="notes-board reveal">
              <div className="seg">
                <button type="button" className={noteKind === 'meeting' ? 'on' : ''} onClick={() => setNoteKind('meeting')}>
                  {t.notesMeeting}
                </button>
                <button type="button" className={noteKind === 'lecture' ? 'on' : ''} onClick={() => setNoteKind('lecture')}>
                  {t.notesLecture}
                </button>
              </div>
              {noteKind === 'meeting' ? (
                <div className="notes-grid">
                  <article><h3>{t.notesSummary}</h3><p>{t.notesMeetSummary}</p></article>
                  <article><h3>{t.notesKeyPoints}</h3><p>{t.notesMeetPoints}</p></article>
                  <article><h3>{t.notesDecisions}</h3><p>{t.notesMeetDecisions}</p></article>
                  <article><h3>{t.notesActions}</h3><p>{t.notesMeetActions}</p></article>
                  <article><h3>{t.notesDetails}</h3><p>{t.notesMeetDetails}</p></article>
                  <article><h3>{t.notesFollowups}</h3><p>{t.notesMeetFollow}</p></article>
                </div>
              ) : (
                <div className="notes-grid">
                  <article><h3>{t.notesSummary}</h3><p>{t.notesLecSummary}</p></article>
                  <article><h3>{t.notesKeyPoints}</h3><p>{t.notesLecPoints}</p></article>
                  <article><h3>{t.notesConcepts}</h3><p>{t.notesLecConcepts}</p></article>
                  <article><h3>{t.notesRevision}</h3><p>{t.notesLecRevision}</p></article>
                  <article><h3>{t.notesDetails}</h3><p>{t.notesLecDetails}</p></article>
                </div>
              )}
              <p className="notes-hint">{noteKind === 'meeting' ? t.notesMeetingHint : t.notesLectureHint}</p>
            </div>
          </div>
        </section>

        <section className="use-cases" id="situations">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.sitEyebrow}</div>
              <h2>{t.sitH}</h2>
            </div>
            <div className="situation-grid reveal">
              <article className="use-case-card">
                <span className="use-case-icon">01</span>
                <h3>{t.sitLecture}</h3>
                <p>{t.sitLectureP}</p>
              </article>
              <article className="use-case-card">
                <span className="use-case-icon">02</span>
                <h3>{t.sitMeeting}</h3>
                <p>{t.sitMeetingP}</p>
              </article>
              <article className="use-case-card">
                <span className="use-case-icon">03</span>
                <h3>{t.sitConversation}</h3>
                <p>{t.sitConversationP}</p>
              </article>
              <article className="use-case-card">
                <span className="use-case-icon">04</span>
                <h3>{t.sitPresentation}</h3>
                <p>{t.sitPresentationP}</p>
              </article>
            </div>
            <aside className="more-use reveal">
              <span className="mono">{t.sitMore}</span>
              <div>
                <h3>{t.sitInterview}</h3>
                <p>{t.sitInterviewP}</p>
              </div>
            </aside>
          </div>
        </section>

        <section className="memory-now" id="memory">
          <div className="shell memory-layout">
            <div className="section-head reveal">
              <div className="eyebrow">{t.memEyebrow}</div>
              <h2>{t.memH}</h2>
              <p>{t.memP}</p>
            </div>
            <div className="memory-card reveal">
              <label>
                <span>SEARCH</span>
                <strong>{t.memQuery}</strong>
              </label>
              <div className="ask-reply">
                <small>NOD</small>
                <p>{t.memAnswer}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="platforms" id="desktop">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.platEyebrow}</div>
              <h2>{t.platH}</h2>
            </div>
            <div className="platform-grid reveal">
              <article>
                <h3>{t.platWeb}</h3>
                <p>{t.platWebP}</p>
                <a className="button button-primary" href={primaryHref} onClick={onHeroCta}>
                  {primaryLabel}
                </a>
              </article>
              <article>
                <h3>{t.platDesk}</h3>
                <p>{t.platDeskP}</p>
                <p className="desktop-status">{t.platDeskNote}</p>
              </article>
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
            <a href="/privacy">{t.navPrivacy}</a>
            <a href="/terms">Terms</a>
            <a href="/signup">{t.footerRegister}</a>
            <a href={signedIn ? '/app' : '/login?next=/app'}>{t.footerWorkspace}</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
