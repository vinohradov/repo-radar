/**
 * Reservation-based output-token budget for one scan.
 *
 * Analyze tasks launch in parallel, so checking "spent so far" at launch time
 * reads 0 for every task and never trips. Instead each agent call RESERVES its
 * max_tokens up front (atomically, synchronous JS) and settles the reservation
 * down to actual usage when the response arrives. A call that cannot reserve
 * is skipped — the cap is a hard ceiling, not a suggestion.
 */
export class TokenBudget {
  private committed = 0;

  constructor(readonly cap: number) {}

  /** Reserve headroom for a call about to be made. False = over budget, skip. */
  tryReserve(maxTokens: number): boolean {
    if (this.committed + maxTokens > this.cap) return false;
    this.committed += maxTokens;
    return true;
  }

  /** Replace a reservation with the actual output tokens used. */
  settle(reserved: number, actualOutputTokens: number): void {
    this.committed += actualOutputTokens - reserved;
  }

  get used(): number {
    return this.committed;
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.committed);
  }
}
