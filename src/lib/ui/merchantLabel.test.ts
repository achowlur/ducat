import { describe, expect, it } from "vitest";
import { merchantLabel } from "./merchantLabel";

const zelle = (description: string) => merchantLabel({ normalizedMerchant: "zelle transfer", description });

describe("merchantLabel", () => {
  it("shows the counterparty for an outgoing P2P payment, not the rail", () => {
    const m = zelle("ZELLE TO FAIRLEY ROBIN ON 07/19 REF # WFCT0000000F");
    expect(m.label).toBe("Zelle To Fairley Robin");
    expect(m.ruleValue).toBe("zelle to fairley robin");
  });

  it("shows the counterparty for an incoming one too", () => {
    const m = zelle("ZELLE FROM BRENNAN NADIA ON 06/10 REF # WFCT0000000G FOR PAPAS BIRTHDAY DINNER");
    expect(m.label).toBe("Zelle From Brennan Nadia");
  });

  it("keeps two different recipients distinct, which is the point", () => {
    // All 64 of these normalize to "zelle transfer", so the merchant column was
    // showing the same string for every person the operator has ever paid.
    const a = zelle("ZELLE TO HOLLIS AMARI ON 07/19 REF # WFCT0000000H");
    const b = zelle("ZELLE TO  LENA ON 07/18 REF # WFCT0000000J GOLDEN LOTUS");
    expect(a.label).not.toBe(b.label);
  });

  it("targets a P2P rule at the DESCRIPTION, where the payee actually appears", () => {
    // A MERCHANT rule built from this would match nothing: the merchant is
    // "zelle transfer" and the name is only ever in the description.
    const m = zelle("ZELLE TO HOLLIS AMARI ON 07/19 REF # WFCT0000000H");
    expect(m.ruleField).toBe("DESCRIPTION");
    expect("zelle to hollis amari on 07/19 ref # wfct0000000h").toContain(m.ruleValue);
  });

  it("never offers the bare rail as a rule value", () => {
    // The footgun this replaces: `merchant contains "zelle transfer"` at user
    // priority recategorizes every Zelle payment in the database at once.
    for (const d of [
      "ZELLE TO FAIRLEY ROBIN ON 07/19 REF # WFCT0000000F",
      "ZELLE FROM WHITLOCK MARCUS ON 06/06 REF # WFCT0000000L",
    ]) {
      expect(zelle(d).ruleValue).not.toBe("zelle transfer");
    }
  });

  it("leaves an ordinary merchant alone", () => {
    const m = merchantLabel({ normalizedMerchant: "river bakery", description: "RIVER BAKERY FAIRVIEW IL" });
    expect(m.label).toBe("River Bakery");
    expect(m.ruleValue).toBe("river bakery");
    expect(m.ruleField).toBe("MERCHANT");
  });

  it("measures the floor against the NAME, not the rail", () => {
    // The trap a plain length check walks into: "ZELLE 12345678" keys to
    // "zelle" — five characters, passes any such floor, and matches every P2P
    // payment in the database as a DESCRIPTION rule. There is no counterparty
    // here, so there is nothing to offer.
    for (const d of ["ZELLE 12345678", "ZELLE TO", "ZELLE PAYMENT ON 07/19"]) {
      const m = zelle(d);
      expect(m.ruleField).toBe("MERCHANT");
      expect(m.ruleValue).toBe("zelle transfer");
    }
  });

  it("accepts a one-word counterparty, which is most of them", () => {
    const m = zelle("ZELLE TO  LENA ON 07/17 REF # WFCT0000000K");
    expect(m.label).toBe("Zelle To Lena");
    expect(m.ruleField).toBe("DESCRIPTION");
  });

  it("uses the description when there is no merchant at all", () => {
    const m = merchantLabel({ normalizedMerchant: "", description: "SOME UNMAPPED THING" });
    expect(m.label).toBe("Some Unmapped Thing");
  });
});
