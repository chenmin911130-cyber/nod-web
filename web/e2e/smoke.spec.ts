import { test, expect } from '@playwright/test'

/**
 * P0 smoke: the app boots and the three workspace switchers are present.
 *
 * The workspace switcher is a tablist ("Workspace mode") with two tabs —
 * "Listen" (interview) and "Translate" — plus a separate "Meeting" button.
 * We assert those from the real accessibility tree rather than guessing at
 * label text from the spec doc, which says "Interview/Meeting/Translate".
 *
 * This proves the whole pipe works (server up, frontend served, browser
 * drives it) WITHOUT needing a real mic or LLM.
 */
test.describe('Nod app shell', () => {
  test('loads the app and shows the workspace switchers', async ({ page }) => {
    await page.goto('/app')

    // Top bar product name.
    await expect(page.locator('body')).toContainText('Nod')

    // The workspace-mode tablist with its tabs.
    await expect(page.getByRole('tablist', { name: /workspace mode/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /listen/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /translate/i })).toBeVisible()

    // Meeting is a separate button, not a tab.
    await expect(page.getByRole('button', { name: /meeting/i })).toBeVisible()
  })
})
