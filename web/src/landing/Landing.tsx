import { useCallback, useEffect, useRef, useState } from 'react'
import { accountDeletedNotice, deleteAccountCopy } from '../accountCopy'
import { fetchMe } from '../auth'
import { isNativeApp } from '../native'
import { applySeo, track } from '../site/track'
import { COPY, type Locale } from './copy'
import { PRODUCT_NAME } from '../brand'
import { SITE_ORIGIN, siteUrl } from '../siteOrigin'
import NodMark from '../site/NodMark'
import { DemoModal, WatchIcon, type DemoMode } from './HeroDemo'
import { HERO_POSTERS, heroPosterById, nextHeroPoster, type HeroPosterId } from './heroPosters'
import './Landing.css'

type AskId = '1' | '2' | '3' | '4'
type NoteKind = 'meeting' | 'lecture'

export default function Landing({ locale = 'en' }: { locale?: Locale; clerkEnabled?: boolean }) {
  const [ask, setAsk] = useState<AskId>('1')
  const [noteKind, setNoteKind] = useState<NoteKind>('meeting')
  const [navOpen, setNavOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [demoOpen, setDemoOpen] = useState(false)
  const [demoMode, setDemoMode] = useState<DemoMode>('meeting')
  const [poster, setPoster] = useState<HeroPosterId>('meeting')
  const [loadedPosters, setLoadedPosters] = useState<HeroPosterId[]>(['meeting'])
  const posterHover = useRef(false)
  const posterManualAt = useRef(0)
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
    applySeo({
      title: t.title,
      description: t.description,
      ogTitle: t.ogTitle,
      url: siteUrl(locale === 'zh' ? '/zh' : '/'),
      lang: t.htmlLang,
      image: `${SITE_ORIGIN}/og.png`,
      robots: 'index,follow',
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

  useEffect(() => {
    const id = window.setInterval(() => {
      if (posterHover.current || demoOpen || Date.now() - posterManualAt.current < 12000) return
      setPoster((current) => nextHeroPoster(current))
    }, 7000)
    return () => window.clearInterval(id)
  }, [demoOpen])

  useEffect(() => {
    setLoadedPosters((current) => (current.includes(poster) ? current : [...current, poster]))
  }, [poster])

  const closeNav = () => setNavOpen(false)
  const onHeroCta = () => track('cta_hero_start', { place: 'hero', signed_in: signedIn })
  const onHeaderCta = () => track('cta_hero_start', { place: 'header' })
  const onPriceCta = () => track('cta_pricing')
  const openDemo = useCallback((mode: DemoMode = 'meeting') => {
    setDemoMode(mode)
    setDemoOpen(true)
    track('watch_demo', { mode })
  }, [])
  const closeDemo = useCallback(() => setDemoOpen(false), [])
  const heroCta = signedIn ? t.enterWorkspace : t.heroCta
  const posterLabel = {
    meeting: t.sitMeeting,
    lecture: t.sitLecture,
    translate: t.demoTranslate,
  } as const
  const posterAlt = {
    meeting: t.heroPosterMeeting,
    lecture: t.heroPosterLecture,
    translate: t.heroPosterTranslate,
  } as const

  return (
    <div className="nod-landing">
      <header className={`site-header${navOpen ? ' nav-open' : ''}`}>
        <div className="shell header-inner">
          <a className="brand" href={home} onClick={closeNav}>
            <NodMark />
            {PRODUCT_NAME}
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
          </nav>
          <div className="header-actions">
            {signedIn ? (
              <a className="button button-ghost" href="/account">
                {t.navAccount}
              </a>
            ) : (
              <a className="button button-ghost" href="/login">
                {t.navSignIn}
              </a>
            )}
            <a className="button button-cyan header-cta" href={primaryHref} onClick={onHeaderCta}>
              {signedIn ? t.enterWorkspace : t.getStarted}
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
        {accountDeletedNotice(typeof location === 'undefined' ? '' : location.search) ? (
          <p className="landing-deleted">{deleteAccountCopy.notice}</p>
        ) : null}
        <section className="hero hero-posters">
          <h1 className="sr-only">{`${t.heroH1a} ${t.heroH1b} ${t.heroH1c}`}</h1>
          <div
            className="hero-poster-stage"
            onMouseEnter={() => {
              posterHover.current = true
            }}
            onMouseLeave={() => {
              posterHover.current = false
            }}
          >
            {HERO_POSTERS.filter((item) => loadedPosters.includes(item.id)).map((item) => (
              <img
                key={item.id}
                src={item.src}
                srcSet={item.srcSet}
                sizes={item.sizes}
                alt={poster === item.id ? posterAlt[item.id] : ''}
                className={poster === item.id ? 'on' : ''}
                fetchPriority={item.id === poster ? 'high' : 'low'}
                decoding="async"
              />
            ))}
          </div>
          <div className="shell hero-poster-bar">
            <div className="hero-poster-nav" role="tablist" aria-label={t.sitH}>
              {HERO_POSTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={poster === item.id}
                  className={poster === item.id ? 'on' : ''}
                  onClick={() => {
                    posterManualAt.current = Date.now()
                    setPoster(item.id)
                    setDemoMode(item.demo)
                  }}
                >
                  {posterLabel[item.id]}
                </button>
              ))}
            </div>
            <div className="hero-actions">
              <a className="button button-cyan" href={primaryHref} onClick={onHeroCta}>
                {heroCta}
                <span aria-hidden="true">→</span>
              </a>
              <button type="button" className="button button-ghost" onClick={() => openDemo(heroPosterById(poster).demo)}>
                <WatchIcon />
                {t.watchDemo}
              </button>
            </div>
          </div>
        </section>

        <DemoModal t={t} open={demoOpen} mode={demoMode} onMode={setDemoMode} onClose={closeDemo} />

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
                <h3>{t.sitInterview}</h3>
                <p>{t.sitInterviewP}</p>
              </article>
            </div>
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
                <small>{t.memHit}</small>
                <p>{t.memAnswer}</p>
              </div>
            </div>
          </div>
        </section>

        {!isNativeApp() && <section className="platforms" id="desktop">
          <div className="shell">
            <div className="section-head reveal">
              <div className="eyebrow">{t.platEyebrow}</div>
              <h2>{t.platH}</h2>
            </div>
            <div className="platform-grid reveal">
              <article>
                <h3>{t.platWeb}</h3>
                <p>{t.platWebP}</p>
                <a className="button button-cyan" href={primaryHref} onClick={onHeroCta}>
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
        </section>}

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
              </div>
              <a className="button button-cyan" href={primaryHref} onClick={onPriceCta}>
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
                <a className="button button-cyan" href={primaryHref} onClick={() => track('cta_hero_start', { place: 'footer' })}>
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
              <NodMark />
              {PRODUCT_NAME}
            </a>
            <p>
              {t.footerTag}
              <br />
              {t.footerCopy}
            </p>
          </div>
          <div className="footer-links">
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
