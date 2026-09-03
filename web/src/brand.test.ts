import {
  COPYRIGHT_HOLDER,
  COPYRIGHT_NOTICE_EN,
  COPYRIGHT_NOTICE_ZH,
  COPYRIGHT_YEAR,
  PRODUCT_MARK,
  PRODUCT_NAME,
} from './brand'
import { PDF_BRAND } from './pdfBrand'

function eq<T>(got: T, want: T, name: string) {
  if (got !== want) throw new Error(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

eq(PRODUCT_NAME, 'Nodpilot', 'product name')
eq(PRODUCT_MARK, 'NODPILOT™', 'unregistered trademark claim')
eq(COPYRIGHT_HOLDER, 'Min Chen', 'copyright holder')
eq(COPYRIGHT_YEAR, 2026, 'copyright year')
eq(COPYRIGHT_NOTICE_EN, '© 2026 Min Chen. NODPILOT™. All rights reserved.', 'english notice')
eq(COPYRIGHT_NOTICE_ZH, '© 2026 Min Chen. NODPILOT™。保留所有权利。', 'chinese notice')
eq(PDF_BRAND, PRODUCT_NAME, 'pdf brand matches product name')
