import { PRODUCT_NAME } from './brand'
import { PDF_BRAND } from './pdfBrand'

function eq<T>(got: T, want: T, name: string) {
  if (got !== want) throw new Error(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

eq(PRODUCT_NAME, 'Nodpilot', 'product name')
eq(PDF_BRAND, PRODUCT_NAME, 'pdf brand matches product name')
