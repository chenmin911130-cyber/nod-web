import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import NodLogo from './NodLogo'
import ModeDemo from './ModeDemo'
import { COPY, type Lang, type ModeId } from './translations'
import './LandingPage.css'

export default function LandingPage() {
  const [lang, setLang] = useState<Lang>('zh')
  const [activeMode, setActiveMode] = useState<ModeId>('interview')
  const t = COPY[lang]

  useEffect(() => {
    document.documentElement.classList.remove('nod-web')
  }, [])

  const toggleLang = () => setLang((l) => (l === 'zh' ? 'en' : 'zh'))

  return (
    <div className="landing">
      <header className="landing-header">
        <div className="landing-header-inner">
          <div className="landing-brand">
            <NodLogo size={26} />
            <span className="landing-brand-name">Nod</span>
          </div>
          <nav className="landing-nav">
            <button type="button" className="landing-lang-btn" onClick={toggleLang} aria-label="Toggle language">
              {t.langToggle}
            </button>
            <Link to="/app" className="landing-nav-cta">
              {t.openApp}
            </Link>
          </nav>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <h1 className="landing-hero-title">{t.heroTitle}</h1>
          <p className="landing-hero-sub">{t.heroSub}</p>

          <div className="landing-claims">
            {t.claims.map((claim) => (
              <span key={claim} className="landing-claim">
                {claim}
              </span>
            ))}
          </div>

          <div className="landing-hero-cta">
            <Link to="/app" className="landing-cta-primary">
              {t.cta}
            </Link>
            <p className="landing-cta-sub">{t.ctaSub}</p>
          </div>
        </section>

        <section className="landing-modes">
          <h2 className="landing-section-title">{t.modesTitle}</h2>

          <div className="landing-mode-tabs" role="tablist" aria-label={t.modesTitle}>
            {t.modes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="tab"
                aria-selected={activeMode === mode.id}
                className={`landing-mode-tab${activeMode === mode.id ? ' active' : ''}`}
                onClick={() => setActiveMode(mode.id)}
              >
                <span className="landing-mode-tab-label">{mode.label}</span>
                <span className="landing-mode-tab-title">{mode.title}</span>
              </button>
            ))}
          </div>

          <p className="landing-mode-desc">{t.modes.find((m) => m.id === activeMode)?.desc}</p>

          <ModeDemo mode={activeMode} lang={lang} />
        </section>

        <section className="landing-benefits">
          <h2 className="landing-section-title">{t.benefitsTitle}</h2>
          <div className="landing-benefit-grid">
            {t.benefits.map((b) => (
              <article key={b.title} className="landing-benefit-card">
                <h3 className="landing-benefit-title">{b.title}</h3>
                <p className="landing-benefit-desc">{b.desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-bottom-cta">
          <Link to="/app" className="landing-cta-primary">
            {t.cta}
          </Link>
        </section>
      </main>

      <footer className="landing-footer">
        <p>{t.footer}</p>
      </footer>
    </div>
  )
}
