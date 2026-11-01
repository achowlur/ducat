import { describe, expect, it } from 'vitest';
import type { TextLine } from './lines';
import { wellsFargoCardPageHeader } from './layouts/wellsFargoCard';
import { groupStatementPages, type PageHeader } from './scanBundle';

const header = (period: string | null, pageNo: number | null, pageOf: number | null, account = '1234'): PageHeader => ({
  period,
  account,
  pageNo,
  pageOf,
});

describe('groupStatementPages', () => {
  it('groups pages by period and orders them as printed, whatever order the scans held them in', () => {
    const { groups, orphans } = groupStatementPages([
      { id: 'a:1', header: header('2025-09-03_2025-10-02', 3, 3) },
      { id: 'a:2', header: header(null, null, null) },
      { id: 'b:7', header: header('2025-09-03_2025-10-02', 1, 3) },
      { id: 'a:3', header: header('2025-09-03_2025-10-02', 2, 3) },
      { id: 'b:1', header: header('2025-08-02_2025-09-02', 1, 3) },
    ]);
    expect(orphans).toEqual(['a:2']);
    expect(groups).toEqual([
      { period: '2025-08-02_2025-09-02', pages: ['b:1'], printed: [1], expected: 3, complete: false },
      { period: '2025-09-03_2025-10-02', pages: ['b:7', 'a:3', 'a:1'], printed: [1, 2, 3], expected: 3, complete: true },
    ]);
  });

  it('keeps a page whose number is unreadable, last, and calls the statement incomplete', () => {
    const { groups } = groupStatementPages([
      { id: 1, header: header('2025-09-03_2025-10-02', null, null) },
      { id: 2, header: header('2025-09-03_2025-10-02', 1, 3) },
      { id: 3, header: header('2025-09-03_2025-10-02', 2, 3) },
    ]);
    expect(groups[0]).toEqual({ period: '2025-09-03_2025-10-02', pages: [2, 3, 1], printed: [1, 2, null], expected: 3, complete: false });
  });
});

describe('wellsFargoCardPageHeader', () => {
  const line = (text: string): TextLine => ({ page: 1, y: 700, cells: [{ x: 300, xEnd: 460, text }], text });

  it('reads either wording of the header, look-alike letters as digits', () => {
    expect(wellsFargoCardPageHeader([line('Account ending in 12S4'), line('Statement Period O9/03/2025 to 10/02/2025'), line('Page l of 3')])).toEqual({
      period: '2025-09-03_2025-10-02',
      account: '1254',
      pageNo: 1,
      pageOf: 3,
    });
    expect(wellsFargoCardPageHeader([line('Account Number Ending in 5678'), line('Statement Billing Period 03/28/2022 to 04/26/2022'), line('Page 2 of 3')])).toEqual({
      period: '2022-03-28_2022-04-26',
      account: '5678',
      pageNo: 2,
      pageOf: 3,
    });
  });

  it('leaves what it cannot read null', () => {
    expect(wellsFargoCardPageHeader([line('Statement Period 13/28/2022 to 04/26/2022'), line('Page ? of 3')])).toEqual({
      period: null,
      account: null,
      pageNo: null,
      pageOf: null,
    });
  });
});
