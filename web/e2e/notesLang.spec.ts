import { test, expect } from '@playwright/test'

/**
 * Meeting/Lecture bilingual target must not share Translate page To
 * (`nod_translate_pair`). Notes Auto + Bilingual uses `notesTranslateTo`.
 */
test.describe('Notes bilingual target vs Translate To', () => {
  test('Translate Japanese does not leak into Meeting Auto bilingual chip', async ({ page }) => {
    await page.goto('/app')

    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByRole('tab', { name: /translate/i })).toHaveAttribute('aria-selected', 'true')
    await page.getByLabel('To', { exact: true }).selectOption('ja')
    await expect(page.getByLabel('To', { exact: true })).toHaveValue('ja')

    await page.getByRole('tab', { name: /listen/i }).click()
    await expect(page.getByRole('tab', { name: /listen/i })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('switch', { name: /bilingual/i })).toHaveAttribute('aria-checked', 'true')

    const chip = page.getByLabel('Notes language')
    await expect(chip).toBeVisible()
    await expect(chip).not.toContainText('Japanese')
  })

  test('Meeting Italian notes does not rewrite Translate To', async ({ page }) => {
    await page.goto('/app')

    await page.getByRole('tab', { name: /translate/i }).click()
    await page.getByLabel('To', { exact: true }).selectOption('ja')

    await page.getByRole('tab', { name: /listen/i }).click()
    await page.getByLabel('Notes language').click()
    await page.getByRole('option', { name: /italian/i }).click()

    await page.getByRole('tab', { name: /translate/i }).click()
    await expect(page.getByLabel('To', { exact: true })).toHaveValue('ja')
  })

  test('Meeting Auto after Italian shows Notes · Auto → Italian', async ({ page }) => {
    await page.goto('/app')

    await page.getByLabel('Notes language').click()
    await page.getByRole('option', { name: /italian/i }).click()
    await page.getByLabel('Notes language').click()
    await page.getByRole('option', { name: /^auto/i }).click()

    await expect(page.getByRole('switch', { name: /bilingual/i })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByLabel('Notes language')).toHaveText('Notes · Auto → Italian')
  })
})
