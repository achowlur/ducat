import { describe, expect, it } from 'vitest';
import { normalizeMerchant } from '../../normalize';
import { wellsFargoPayee } from './wellsFargoPayee';

// Every description is INVENTED, in the shape a Wells Fargo deposit statement prints.
describe('wellsFargoPayee', () => {
  it('reads a card purchase, recurring payment or return as the merchant after the date', () => {
    expect(wellsFargoPayee('Purchase authorized on 03/02 Corner Cafe Springfield IL S000000000000001 Card 1234')).toBe(
      'Corner Cafe Springfield IL',
    );
    expect(wellsFargoPayee('Recurring Payment authorized on 03/09 Example Streaming 800-000-0000 CA S000000000000002 Card 1234')).toBe(
      'Example Streaming 800-000-0000 CA',
    );
    expect(wellsFargoPayee('Purchase Return authorized on 03/11 Example Outfitters Springfield IL S000000000000003 Card 1234')).toBe(
      'Example Outfitters Springfield IL',
    );
  });

  // One merchant's rows differ only in date and S-number, so their keys must not.
  it('gives two charges from one merchant the same merchant key', () => {
    const a = normalizeMerchant(wellsFargoPayee('Purchase authorized on 03/02 Corner Cafe Springfield IL S000000000000001 Card 1234'));
    const b = normalizeMerchant(wellsFargoPayee('Purchase authorized on 04/17 Corner Cafe Springfield IL S000000000000009 Card 1234'));
    expect(a).toBe('corner cafe springfield il');
    expect(b).toBe(a);
  });

  it('reads an ATM line as its kind, never its place', () => {
    expect(wellsFargoPayee('ATM Check Deposit on 03/02 1 Example St Springfield IL 0000001 ATM ID 0000A Card 1234')).toBe('ATM Check Deposit');
    expect(wellsFargoPayee('ATM Withdrawal authorized on 03/02 Example Branch Springfield IL 0000001 ATM ID 0000A Card 1234')).toBe(
      'ATM Withdrawal',
    );
  });

  it('reads a transfer as its direction and account, without its reference, number or date', () => {
    expect(wellsFargoPayee('Online Transfer Ref #Ib0000000 to Example Card Xxxxxxxxxxxx0001 on 03/02/26')).toBe('Online Transfer to Example Card');
    expect(wellsFargoPayee('Online Transfer From Example Savings xxxxxx0002 Ref #Ib0000001 on 03/02/26')).toBe(
      'Online Transfer From Example Savings',
    );
    expect(wellsFargoPayee('Transfer From Example J Checking Ref #Ib0000002 xxxxxxxxx0003')).toBe('Transfer From Example J Checking');
  });

  it('reads an ACH line up to its first code, leaving the holder name off', () => {
    expect(wellsFargoPayee('Example Payroll Direct Dep 260302 0000000001 Doe, Jane')).toBe('Example Payroll Direct Dep');
    expect(wellsFargoPayee('Example Brokerage Moneyline 260302 X00000001 Jane Doe')).toBe('Example Brokerage Moneyline');
  });

  // Zelle keys on the person through payeeKey; a name that STARTS with a number keeps it.
  it('leaves Zelle and a plain line as they are, and keeps a leading number', () => {
    expect(wellsFargoPayee('Zelle to Example Person on 03/02 Ref #Ex0000000')).toBe('Zelle to Example Person on 03/02 Ref #Ex0000000');
    expect(wellsFargoPayee('24 Example Fitness 0000001')).toBe('24 Example Fitness');
    expect(wellsFargoPayee('Deposit Made In A Branch/Store')).toBe('Deposit Made In A Branch/Store');
  });
});
