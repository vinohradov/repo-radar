import { EventEmitter } from "node:events";
import type { ScanEvent } from "@repo-radar/shared";

/**
 * Tiny in-process pub/sub for scan progress. Routes subscribe per scanId and
 * receive events until the scan finishes. Fine for a single-process PoC.
 */
class ScanEventBus extends EventEmitter {
  emitScan(event: ScanEvent): void {
    this.emit(event.scanId, event);
    this.emit("*", event);
  }

  subscribe(scanId: string, listener: (e: ScanEvent) => void): () => void {
    this.on(scanId, listener);
    return () => this.off(scanId, listener);
  }
}

export const scanEvents = new ScanEventBus();
scanEvents.setMaxListeners(0);
