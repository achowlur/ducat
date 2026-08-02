import { describe, expect, it } from "vitest";
import { groupHref, normalizeGroupLabel, parseGroupParam, MAX_GROUP_LABEL } from "./groupFilter";

describe("normalizeGroupLabel", () => {
  it("trims and collapses inner whitespace, so two labels cannot differ invisibly", () => {
    expect(normalizeGroupLabel("  Tess's   March trip ")).toBe("Tess's March trip");
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(normalizeGroupLabel("")).toBeNull();
    expect(normalizeGroupLabel("   ")).toBeNull();
  });

  it("returns null past MAX_GROUP_LABEL — an overlong label never becomes a create option", () => {
    expect(normalizeGroupLabel("x".repeat(MAX_GROUP_LABEL))).toBe("x".repeat(MAX_GROUP_LABEL));
    expect(normalizeGroupLabel("x".repeat(MAX_GROUP_LABEL + 1))).toBeNull();
  });
});

describe("parseGroupParam", () => {
  it("null when the param is absent or empty — no filter is not an empty filter", () => {
    expect(parseGroupParam(undefined)).toBeNull();
    expect(parseGroupParam("")).toBeNull();
    expect(parseGroupParam("  ")).toBeNull();
  });

  it("normalizes what it reads, matching what assignment wrote", () => {
    expect(parseGroupParam("Tess's  March trip")).toBe("Tess's March trip");
  });

  it('a label of "1" is just a label — the payee queue moved to ?payees=', () => {
    expect(parseGroupParam("1")).toBe("1");
  });
});

describe("the round trip a link actually makes", () => {
  // The label the whole feature is tested with: a SPACE and an APOSTROPHE,
  // through the href builder, URL parsing, and back out of the param.
  it("a space and an apostrophe survive href → URL → param → label", () => {
    const label = "Tess's March trip";
    const href = groupHref(label);
    expect(href.startsWith("/transactions?")).toBe(true);
    const wire = new URLSearchParams(href.split("?")[1]).get("group");
    expect(wire).toBe(label); // URLSearchParams decodes what it encoded
    expect(parseGroupParam(wire ?? undefined)).toBe(label);
  });

  it("an ampersand or equals cannot smuggle a second param", () => {
    const label = "R&R + reset = fun";
    const params = new URLSearchParams(groupHref(label).split("?")[1]);
    expect([...params.keys()]).toEqual(["group"]);
    expect(parseGroupParam(params.get("group") ?? undefined)).toBe(label);
  });
});
