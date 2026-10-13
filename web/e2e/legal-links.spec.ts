import { test, expect } from '@playwright/test'

const ME_NO_CONSENT = {
  id: 'e2e-user',
  email: 'e2e@nod.test',
  name: 'E2E User',
  plan: 'free',
  plan_name: 'Free',
  subscription_status: 'none',
  consent: false,
  created_at: null,
  usage: {
    ok: true,
    stt_seconds: 0,
    stt_limit: 0,
    llm_tokens: 0,
    llm_limit: 0,
    sessions: 0,
    session_limit: 0,
    daily_cost_usd: 0,
    daily_cost_limit: 0,
    quota_disabled: true,
  },
  plans: [],
  stripe_enabled: false,
  quota_disabled: true,
}

test.describe('Legal links open on the public site (T67)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('Account privacy and terms open nodpilot.com in a new tab', async ({ page, context }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Account' }).click()
    await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible()

    const privacyPagePromise = context.waitForEvent('page')
    await page.getByRole('button', { name: 'Privacy policy' }).click()
    const privacyPage = await privacyPagePromise
    await privacyPage.waitForLoadState('domcontentloaded')
    await expect(privacyPage).toHaveURL('https://nodpilot.com/privacy')
    await privacyPage.close()

    const termsPagePromise = context.waitForEvent('page')
    await page.getByRole('button', { name: 'Terms of service' }).click()
    const termsPage = await termsPagePromise
    await termsPage.waitForLoadState('domcontentloaded')
    await expect(termsPage).toHaveURL('https://nodpilot.com/terms')
    await termsPage.close()
  })

  test('consent sheet links use absolute nodpilot.com URLs', async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ME_NO_CONSENT),
      })
    })
    await page.addInitScript(() => {
      localStorage.setItem('nod_token', 'e2e-legal-links-token')
    })
    await page.goto('/app')
    await page.getByRole('button', { name: 'Start listening' }).click()
    await expect(page.getByRole('heading', { name: 'Before you start recording' })).toBeVisible()

    const privacy = page.getByRole('link', { name: 'privacy policy' })
    const consentNote = page.getByRole('link', { name: 'consent note' })
    await expect(privacy).toHaveAttribute('href', 'https://nodpilot.com/privacy')
    await expect(consentNote).toHaveAttribute('href', 'https://nodpilot.com/consent')
    await expect(privacy).toHaveAttribute('target', '_blank')
    await expect(consentNote).toHaveAttribute('target', '_blank')
  })
})
