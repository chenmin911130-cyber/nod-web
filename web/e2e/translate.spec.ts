import { test, expect } from '@playwright/test'

/**
 * P0 regression: typing a line in the Translate workspace must issue exactly
 * ONE ask and render the source once.
 *
 * The P0 bug was the phase handler treating every `capture==='off'` phase as
 * "session stopped", clearing the in-flight translate and re-pumping -> two
 * `ask`s -> the translation rendered twice (叠字) and eventually Failed. The fix
 * gates that cleanup on `engine==='idle'`. This test hooks the client's send
 * layer to count `ask` messages (the raw signal, independent of whether the
 * mock LLM actually answers) and asserts it stays at 1.
 */
test.describe('Translate workspace typing', () => {
  test('one typed line issues exactly one ask and shows the source once', async ({ page }) => {
    await page.goto('/app')
    const translateTab = page.getByRole('tab', { name: /translate/i })
    await translateTab.click()

    // Count `ask` messages the client emits (P0 regression = a duplicate ask).
    await page.evaluate(() => {
      const api = window as unknown as { api?: { send: (m: { type?: string }) => void }; __asks: number }
      window.__asks = 0
      if (api.api && api.api.send) {
        const orig = api.api.send.bind(api.api)
        api.api.send = (m: { type?: string }) => {
          if (m && m.type === 'ask') window.__asks += 1
          return orig(m)
        }
      }
    })

    const input = page.locator('input.prompt-input')
    await expect(input).toBeVisible()
    const line = 'Dobbiamo finire il lavoro entro domani'
    await input.fill(line)
    await input.press('Enter')

    // Let the pump microtask + a WS round-trip run (well under the 25s retry timer).
    await page.waitForTimeout(2000)

    const asks = await page.evaluate(() => window.__asks)
    expect(asks).toBe(1)

    // The source line must appear exactly once on screen (no duplicated row).
    const sourceCount = await page.getByText(line, { exact: false }).count()
    expect(sourceCount).toBe(1)
  })
})
