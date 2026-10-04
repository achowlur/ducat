import { describe, expect, it } from "vitest";
import { finishedInMemory, flowFinish, parseFlowParam, sqlFlow, type FlowRow } from "./flowFilter";

const INCOME_CATEGORY = "cat-salary";
const incomeIds = new Set([INCOME_CATEGORY]);

const row = (partial: Partial<FlowRow> & Pick<FlowRow, "flow">): FlowRow => ({
  categoryId: null,
  reimbursesId: null,
  reimburses: null,
  ...partial,
});

const salary = row({ flow: "INFLOW", categoryId: INCOME_CATEGORY });
const deposit = row({ flow: "INFLOW" });
const refund = row({ flow: "INFLOW", categoryId: "cat-dining" });
const repaid = row({ flow: "INFLOW", reimbursesId: "bill", reimburses: { flow: "OUTFLOW" } });
const repaidCategorized = row({ flow: "INFLOW", categoryId: INCOME_CATEGORY, reimbursesId: "bill", reimburses: { flow: "OUTFLOW" } });
const linkedToIncome = row({ flow: "INFLOW", reimbursesId: "pay", reimburses: { flow: "INFLOW" } });
const linkedToGone = row({ flow: "INFLOW", reimbursesId: "gone", reimburses: null });
const purchase = row({ flow: "OUTFLOW", categoryId: "cat-dining" });
const transfer = row({ flow: "TRANSFER" });

describe("parseFlowParam", () => {
  it("reads a row's own flow and the two figures, and nothing else", () => {
    for (const flow of ["OUTFLOW", "INFLOW", "TRANSFER", "SPENDING", "INCOME"]) expect(parseFlowParam(flow)).toBe(flow);
    expect(parseFlowParam(undefined)).toBeNull();
    expect(parseFlowParam("")).toBeNull();
    expect(parseFlowParam("income")).toBeNull();
    expect(parseFlowParam("REFUND")).toBeNull();
  });
});

describe("sqlFlow", () => {
  it("answers a row's own flow exactly, and narrows the two figures to a superset", () => {
    expect(sqlFlow("OUTFLOW")).toBe("OUTFLOW");
    expect(sqlFlow("TRANSFER")).toBe("TRANSFER");
    expect(sqlFlow("INCOME")).toBe("INFLOW");
    expect(sqlFlow("SPENDING")).toEqual({ not: "TRANSFER" });
    expect(finishedInMemory("INFLOW")).toBe(false);
    expect(finishedInMemory(null)).toBe(false);
    expect(finishedInMemory("SPENDING")).toBe(true);
  });
});

describe("flowFinish", () => {
  it("leaves a row's own flow to SQL", () => {
    expect(flowFinish("INFLOW", incomeIds)).toBeNull();
    expect(flowFinish(null, incomeIds)).toBeNull();
  });

  it("keeps as income only money in that does not reimburse", () => {
    const keeps = flowFinish("INCOME", incomeIds)!;
    expect([salary, deposit].every(keeps)).toBe(true);
    // A refund in a spending category, and every linked row, reimburse.
    expect([refund, repaid, repaidCategorized, linkedToIncome, linkedToGone, purchase, transfer].some(keeps)).toBe(false);
  });

  it("keeps as spending money out and every credit filed under itself", () => {
    const keeps = flowFinish("SPENDING", incomeIds)!;
    expect([purchase, refund, linkedToIncome, linkedToGone].every(keeps)).toBe(true);
    // Income and transfers are not spending; a repayment linked to an outflow
    // credits that bill and arrives as its REPAID instead.
    expect([salary, deposit, repaid, repaidCategorized, transfer].some(keeps)).toBe(false);
  });
});
