import { AsyncLocalStorage } from "node:async_hooks";
import { LIMITS } from "./constants.js";
import { UserFacingError } from "./errors.js";

export const requestSignals = new AsyncLocalStorage<AbortSignal>();
export const operationSignals = new AsyncLocalStorage<AbortSignal>();

export function assertOperationActive(): void {
  if (operationSignals.getStore()?.aborted) {
    throw new UserFacingError("REQUEST_CANCELLED", "요청이 취소되었거나 처리 시간이 초과되었습니다.");
  }
}

export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  get pending(): number { return this.count; }

  run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.count >= LIMITS.operationQueueMax) {
      return Promise.reject(new UserFacingError("BUSY", "처리 중인 요청이 많습니다. 잠시 후 다시 시도해 주세요."));
    }
    const parent = requestSignals.getStore();
    const deadline = AbortSignal.timeout(LIMITS.operationTimeoutMs);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    this.count += 1;
    const operation = this.tail.then(() => operationSignals.run(signal, async () => {
      assertOperationActive();
      return callback();
    }));
    this.tail = operation.then(() => undefined, () => undefined).finally(() => { this.count -= 1; });
    return operation;
  }

  async drain(): Promise<void> { await this.tail; }
}
