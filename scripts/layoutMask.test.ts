import { describe, expect, it } from 'vitest';
import { maskDigits, maskFigures, maskLayoutText } from './layoutMask';

describe('maskLayoutText', () => {
  // Every name below is invented; the point is that none of them survives.
  it('hides names, addresses and merchants, keeping their shape', () => {
    expect(maskLayoutText('JANE Q DOE')).toBe('XXXX X XXX');
    expect(maskLayoutText('123 Maple Street Apt 4')).toBe('### Xxxxx Xxxxxx Xxx #');
    expect(maskLayoutText('Zelle to Tess Example on 03/02')).toBe('Zelle to Xxxx Xxxxxxx on ##/##');
    expect(maskLayoutText('EXAMPLE GROCER 0042 SPRINGFIELD IL')).toBe('XXXXXXX XXXXXX #### XXXXXXXXXXX XX');
  });

  it('keeps the vocabulary a parser keys on', () => {
    expect(maskLayoutText('Beginning balance on 12/08')).toBe('Beginning balance on ##/##');
    expect(maskLayoutText('Deposits/ Additions')).toBe('Deposits/ Additions');
    expect(maskLayoutText('Purchase authorized on 01/03 CORNER CAFE')).toBe('Purchase authorized on ##/## XXXXXX XXXX');
    expect(maskLayoutText('Opening/Closing Date 12/03/24 - 01/02/25')).toBe('Opening/Closing Date ##/##/## - ##/##/##');
    expect(maskLayoutText('$1,234.56')).toBe('$#,###.##');
    expect(maskLayoutText('Change in Investment Value')).toBe('Change in Investment Value');
    expect(maskLayoutText('Exchanges In')).toBe('Exchanges In');
  });

  it('masks a word that only CONTAINS vocabulary', () => {
    expect(maskLayoutText('Cardinal Bankside')).toBe('Xxxxxxxx Xxxxxxxx');
  });
});

describe('maskFigures', () => {
  it('hides amounts and account digits, keeping positions and statement dates', () => {
    expect(maskFigures('rows add up to 1,424.50 but the balance moved -374.50')).toBe(
      'rows add up to #.## but the balance moved #.##',
    );
    expect(maskFigures('no single Chase credit account ending in 1234')).toBe('no single Chase credit account ending in ####');
    expect(maskFigures('the 09/03 row: its text ends at x 46, 452; the column ends at x 486')).toBe(
      'the 09/03 row: its text ends at x 46, 452; the column ends at x 486',
    );
    expect(maskFigures('this 2025-02-10 to 2025-03-13 statement')).toBe('this 2025-02-10 to 2025-03-13 statement');
  });

  // A brokerage numbers its accounts with a dash; a refusal naming one must not carry it.
  it('hides a dashed account number whole', () => {
    expect(maskFigures('account X12-345678: the summary has no line')).toBe('account X##-######: the summary has no line');
    expect(maskFigures('account 123-456789 shows "Deposits"')).toBe('account ###-###### shows "Deposits"');
    expect(maskFigures('the line at x 262-297')).toBe('the line at x 262-297');
  });
});

describe('maskDigits', () => {
  it('masks digits and nothing else', () => {
    expect(maskDigits('JANE DOE 12/08 $40.00')).toBe('JANE DOE ##/## $##.##');
  });
});
