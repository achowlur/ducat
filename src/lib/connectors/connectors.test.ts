import { describe, expect, it } from 'vitest';
import { CsvConnector } from './csv';
import { CSV_MAPPINGS } from './csvMappings';
import { parseCsv } from './csvParser';
import { normalizeMerchant } from './normalize';
import { inferAccountType } from './simplefin';

describe('parseCsv', () => {
  it('handles quoted fields, embedded commas, escaped quotes, CRLF', () => {
    const input = 'a,"b,c","say ""hi""",d\r\n1,2,3,4\n';
    expect(parseCsv(input)).toEqual([
      ['a', 'b,c', 'say "hi"', 'd'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('drops blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n   \n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('normalizeMerchant', () => {
  it('lowercases and strips reference noise', () => {
    expect(normalizeMerchant('PURCHASE AUTHORIZED ON 07/08 SHELL OIL 57444199 #4821')).toBe(
      'purchase authorized on shell oil',
    );
    expect(normalizeMerchant('7-ELEVEN')).toBe('7-eleven');
  });
});

describe('CsvConnector: Chase checking', () => {
  const csv = [
    'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
    'DEBIT,07/08/2026,POS PURCHASE WHOLE FOODS,-218.22,DEBIT_CARD,10148.69,',
    'CREDIT,07/01/2026,ACME CORP PAYROLL,6479.32,ACH_CREDIT,10366.91,',
  ].join('\n');
  const account = { externalId: 'chase-1', name: 'Chase Checking', institution: 'Chase', type: 'DEPOSITORY' as const };

  it('normalizes amounts, dates, flow, and takes balance from the latest row', async () => {
    const connector = new CsvConnector(csv, CSV_MAPPINGS['chase-checking'], account);
    const txns = await connector.fetchTransactions(new Date(0));
    expect(txns).toHaveLength(2);
    const [purchase, payroll] = txns;
    expect(purchase.amount).toBe(-218.22);
    expect(purchase.flow).toBe('OUTFLOW');
    expect(purchase.date.toISOString().slice(0, 10)).toBe('2026-07-08');
    expect(payroll.flow).toBe('INFLOW');

    const [acct] = await connector.listAccounts();
    expect(acct.balance).toBe(10148.69); // July 8 row is latest
    expect(acct.isStale).toBe(false);
    expect(acct.connectorType).toBe('CSV');
  });

  it('produces deterministic externalIds that distinguish same-day duplicates', async () => {
    const dupeCsv = [
      'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
      'DEBIT,07/08/2026,COFFEE SHOP,-4.50,DEBIT_CARD,100.00,',
      'DEBIT,07/08/2026,COFFEE SHOP,-4.50,DEBIT_CARD,95.50,',
    ].join('\n');
    const first = await new CsvConnector(dupeCsv, CSV_MAPPINGS['chase-checking'], account).fetchTransactions(new Date(0));
    const second = await new CsvConnector(dupeCsv, CSV_MAPPINGS['chase-checking'], account).fetchTransactions(new Date(0));
    expect(first[0].externalId).not.toBe(first[1].externalId); // two coffees stay distinct
    expect(first.map((t) => t.externalId)).toEqual(second.map((t) => t.externalId)); // re-parse identical
  });

  // Backfilling behind a live feed: a CSV row's id is a content hash and the
  // feed's is its own id, so overlapping rows would NOT dedupe — the cap is
  // what keeps them from double-counting.
  describe('until cap', () => {
    const capped = () =>
      new CsvConnector(csv, CSV_MAPPINGS['chase-checking'], {
        ...account,
        until: new Date(Date.UTC(2026, 6, 5)), // 2026-07-05
      });

    it('drops rows on or after the cut-off', async () => {
      const txns = await capped().fetchTransactions(new Date(0));
      expect(txns).toHaveLength(1);
      expect(txns[0].date.toISOString().slice(0, 10)).toBe('2026-07-01'); // Jul 8 excluded
    });

    it('never reports a current balance for a capped (historical) import', async () => {
      const [acct] = await capped().listAccounts();
      expect(acct.isStale).toBe(true); // so sync leaves the live balance alone
      expect(acct.balance).toBe(0);
    });
  });
});

// Fidelity exports every account into one file, so rows must be routed rather
// than all filed under a single account.
describe('CsvConnector: multi-account file', () => {
  const mapping = { ...CSV_MAPPINGS['chase-checking'], account: 'Account' };
  const csv = [
    'Account,Posting Date,Description,Amount,Balance',
    'X1234-0001,07/08/2026,DIVIDEND,10.00,100.00',
    'X9999-0006,07/09/2026,DIVIDEND,20.00,200.00',
    'X0000-1111,07/10/2026,MYSTERY,30.00,300.00',
  ].join('\n');

  const desc = (externalId: string, name: string) => ({
    externalId, name, institution: 'Fidelity', type: 'INVESTMENT' as const,
  });
  // Mirrors the importer: match on a shared digit tail, refuse otherwise.
  const resolver = (raw: string) =>
    raw.includes('0001') ? desc('acct-a', 'ROTH (0001)')
    : raw.includes('0006') ? desc('acct-b', 'TOD (0006)')
    : null;

  it('routes each row to its own account', async () => {
    const txns = await new CsvConnector(csv, mapping, resolver).fetchTransactions(new Date(0));
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.accountExternalId)).toEqual(['acct-a', 'acct-b']);
  });

  it('lists every account the file actually contained', async () => {
    const accounts = await new CsvConnector(csv, mapping, resolver).listAccounts();
    expect(accounts.map((a) => a.externalId)).toEqual(['acct-a', 'acct-b']);
    expect(accounts[0].balance).toBe(100); // per-account balance, not the file's last row
  });

  it('skips and reports unroutable rows instead of guessing an account', async () => {
    const connector = new CsvConnector(csv, mapping, resolver);
    expect(connector.unresolvedAccounts.get('X0000-1111')).toBe(1);
    const txns = await connector.fetchTransactions(new Date(0));
    expect(txns.some((t) => t.description.includes('MYSTERY'))).toBe(false);
  });

  it('fails loudly when the account column is missing rather than lumping rows together', () => {
    const noAccountColumn = 'Posting Date,Description,Amount,Balance\n07/08/2026,X,1.00,2.00';
    expect(() => new CsvConnector(noAccountColumn, mapping, resolver)).toThrow(/account column/i);
  });
});

describe('CsvConnector: Wells Fargo (headerless)', () => {
  it('parses positional columns', async () => {
    const csv = '"07/10/2026","-45.00","*","","PURCHASE AUTHORIZED AT SHELL GAS 12345678"\n"07/09/2026","1200.00","*","","DIRECT DEPOSIT EMPLOYER"';
    const connector = new CsvConnector(csv, CSV_MAPPINGS['wells-fargo'], {
      externalId: 'wf-1', name: 'WF Checking', institution: 'Wells Fargo', type: 'DEPOSITORY',
    });
    const txns = await connector.fetchTransactions(new Date(0));
    expect(txns).toHaveLength(2);
    expect(txns[0].amount).toBe(-45);
    expect(txns[0].normalizedMerchant).toContain('shell gas');
    const [acct] = await connector.listAccounts();
    expect(acct.isStale).toBe(true); // no balance column
  });
});

describe('CsvConnector: Fidelity brokerage', () => {
  const csv = [
    'Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date',
    '07/07/2026,YOU BOUGHT VANGUARD S&P 500 ETF,VOO,VANGUARD S&P 500 ETF,Cash,2,1309.47,0,0,0,-2618.94,07/09/2026',
    '07/01/2026,DIVIDEND RECEIVED,VOO,VANGUARD S&P 500 ETF,Cash,0,0,0,0,0,83.32,',
    '06/28/2026,TRANSFER OF ASSETS,,CONTRIBUTION FROM CHECKING,Cash,0,0,0,0,0,2591.73,',
    '',
    '"The data and information in this spreadsheet is provided to you..."',
  ].join('\n');

  it('flags buys and contributions as TRANSFER, dividends as INFLOW, skips footer junk', async () => {
    const connector = new CsvConnector(csv, CSV_MAPPINGS.fidelity, {
      externalId: 'fid-1', name: 'Brokerage', institution: 'Fidelity', type: 'INVESTMENT',
    });
    const txns = await connector.fetchTransactions(new Date(0));
    expect(txns).toHaveLength(3); // disclaimer row skipped

    const buy = txns.find((t) => t.description.includes('YOU BOUGHT'));
    const dividend = txns.find((t) => t.description.includes('DIVIDEND'));
    const contribution = txns.find((t) => t.description.includes('CONTRIBUTION'));
    expect(buy?.flow).toBe('TRANSFER'); // investing, not spending
    expect(buy?.amount).toBe(-2618.94);
    expect(buy?.normalizedMerchant).toBe('voo');
    expect(dividend?.flow).toBe('INFLOW');
    expect(contribution?.flow).toBe('TRANSFER');
  });
});

describe('inferAccountType', () => {
  it('guesses from name and institution keywords', () => {
    expect(inferAccountType('Rewards Visa', 'Capital Bank')).toBe('CREDIT');
    expect(inferAccountType('Auto Loan', 'Capital Bank')).toBe('LOAN');
    expect(inferAccountType('RETIREMENT IRA', 'Fidelity')).toBe('INVESTMENT');
    expect(inferAccountType('Primary Checking', 'First National')).toBe('DEPOSITORY');
  });
});
