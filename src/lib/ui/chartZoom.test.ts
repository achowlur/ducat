import { describe, expect, it } from "vitest";
import { clampWindow, fullWindow, isFull, MIN_SPAN, panBy, pinchWindow, shownMonths, zoomAround } from "./chartZoom";

const N = 95; // a long history: indices 0..94

describe("zoomAround", () => {
  it("keeps the month under the pointer under it", () => {
    const w = zoomAround(fullWindow(N), 0.5, 0.25, N);
    expect(w.end - w.start).toBeCloseTo(47);
    // 0.25 across the full window was month 23.5; it is still 0.25 across.
    expect(w.start + 0.25 * (w.end - w.start)).toBeCloseTo(23.5);
  });

  it("never zooms in past MIN_SPAN months, nor out past the whole series", () => {
    let w = fullWindow(N);
    for (let i = 0; i < 50; i += 1) w = zoomAround(w, 0.5, 0.5, N);
    expect(w.end - w.start).toBe(MIN_SPAN);
    for (let i = 0; i < 50; i += 1) w = zoomAround(w, 2, 0.5, N);
    expect(w).toEqual(fullWindow(N));
  });

  it("stays inside the series when zooming at an edge", () => {
    const w = zoomAround({ start: 80, end: 94 }, 1.5, 1, N);
    expect(w.end).toBe(94);
    expect(w.start).toBeCloseTo(73);
  });
});

describe("panBy", () => {
  it("moves along the series and stops at either end, its width kept", () => {
    expect(panBy({ start: 10, end: 22 }, 5, N)).toEqual({ start: 15, end: 27 });
    expect(panBy({ start: 10, end: 22 }, -40, N)).toEqual({ start: 0, end: 12 });
    expect(panBy({ start: 80, end: 92 }, 40, N)).toEqual({ start: 82, end: 94 });
  });
});

describe("pinchWindow", () => {
  it("halves the width when the fingers spread to twice their distance", () => {
    const w = pinchWindow(fullWindow(N), 100, 200, 0.5, 0.5, N);
    expect(w.end - w.start).toBeCloseTo(47);
    expect((w.start + w.end) / 2).toBeCloseTo(47);
  });

  it("moves along the line when both fingers slide, spread unchanged", () => {
    const from = { start: 40, end: 52 };
    // The month at the midpoint (46) follows the midpoint from 0.5 to 0.75.
    const w = pinchWindow(from, 150, 150, 0.5, 0.75, N);
    expect(w.end - w.start).toBeCloseTo(12);
    expect(w.start + 0.75 * 12).toBeCloseTo(46);
  });
});

describe("windows on a short series", () => {
  it("lets a series shorter than MIN_SPAN show all of itself and nothing more", () => {
    expect(clampWindow({ start: 0, end: 0.5 }, 3)).toEqual({ start: 0, end: 2 });
    expect(isFull(fullWindow(3), 3)).toBe(true);
    expect(fullWindow(0)).toEqual({ start: 0, end: 0 });
  });

  it("names the whole months a fractional window shows", () => {
    expect(shownMonths({ start: 10.4, end: 21.7 })).toEqual({ first: 11, last: 21 });
    expect(shownMonths({ start: 10, end: 22 })).toEqual({ first: 10, last: 22 });
  });
});
