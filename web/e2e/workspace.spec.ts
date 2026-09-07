import { test, expect } from '@playwright/test'

/**
 * Workspace switching (P0).
 *
 * The workspace switcher is the "Workspace mode" tablist with two tabs:
 * "Listen" (interview; internal id 'meeting' maps to label "Listen") and
 * "Translate". Switching tabs must flip which tab is selected and swap the
 * workspace body. Meeting is reached from the Listen pane's own button, not
 * a tab, so it is covered in the meeting spec, not here.
 */
test.describe('Workspace switcher', () => {
  test('starts on Listen and can switch to Translate and back', async ({ page }) => {
    await page.goto('/app')

    const tablist = page.getByRole('tablist', { name: /workspace mode/i })
    await expect(tablist).toBeVisible()

    const listenTab = page.getByRole('tab', { name: /listen/i })
    const translateTab = page.getByRole('tab', { name: /translate/i })
    await expect(listenTab).toHaveAttribute('aria-selected', 'true')

    // Switch to Translate. The selected tab is the source of truth — do not
    // wait for a Mode · Translate toast (those stay off the title bar).
    await translateTab.click()
    await expect(translateTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.tr-voice-row')).toBeVisible()

    // Switch back to Listen (interview). Its scene shows "Notes · Meeting".
    await listenTab.click()
    await expect(listenTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('body')).toContainText('Notes · Meeting')
  })
})
