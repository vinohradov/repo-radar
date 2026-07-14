import { describe, it, expect } from "vitest";
import { TokenBudget } from "./budget.js";

describe("TokenBudget", () => {
  it("reserves up to the cap and rejects beyond it", () => {
    const b = new TokenBudget(10_000);
    expect(b.tryReserve(8_000)).toBe(true);
    expect(b.tryReserve(4_000)).toBe(false); // would exceed 10k
    expect(b.tryReserve(2_000)).toBe(true);
    expect(b.remaining).toBe(0);
  });

  it("enforces the cap under parallel launches (the mid-batch case)", () => {
    // 4 tasks of max 4096 against a 10k cap: only 2 may launch, regardless
    // of the fact that none has reported usage yet.
    const b = new TokenBudget(10_000);
    const launched = [4096, 4096, 4096, 4096].filter((t) => b.tryReserve(t));
    expect(launched.length).toBe(2);
  });

  it("settling a reservation down to actual usage frees headroom", () => {
    const b = new TokenBudget(10_000);
    expect(b.tryReserve(8_000)).toBe(true);
    b.settle(8_000, 500); // actual output was tiny
    expect(b.used).toBe(500);
    expect(b.tryReserve(8_000)).toBe(true); // headroom restored
  });
});
