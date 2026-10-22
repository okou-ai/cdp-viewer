import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient } from "../cdp/client";
import { isRecord } from "../cdp/errors";
import { releaseRuntimeObjects } from "../cdp/runtime-objects";
import type { Preedit } from "./composition";
import type { InputLifecycle, InputOwner } from "./lifecycle";
import type { Point } from "./geometry";

interface Wheel {
  point: Point;
  modifiers: number;
  deltaX: number;
  deltaY: number;
}

type InputMethod =
  "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent" | "Input.insertText";

export interface InputJob {
  readonly owner: InputOwner;
  readonly text?: string;
  preedit?: Preedit;
  wheel?: Wheel;
  request<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
  dispatch<M extends InputMethod>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
    acknowledged?: () => void,
  ): void;
}

interface QueuedJob extends InputJob {
  run: (job: InputJob) => void | Promise<void>;
  move: boolean;
  started: boolean;
  cancelled?: boolean;
  prepare?: (job: InputJob) => Promise<void>;
  barrier?: boolean;
  cancel?: () => void;
  valid?: () => boolean;
}

/** Preparation and sends are ordered; bounded acknowledgements settle separately. */
export class InputQueue {
  private readonly jobs: QueuedJob[] = [];
  private readonly pending = new Set<Promise<void>>();
  private running = false;
  private active: QueuedJob | null = null;

  constructor(
    private readonly client: CdpClient,
    private readonly lifecycle: InputLifecycle,
    private readonly member: () => Promise<boolean>,
    private readonly failed: (error?: unknown) => void,
  ) {}

  clear(): void {
    this.active?.cancel?.();
    for (const job of this.jobs) job.cancel?.();
    this.jobs.length = 0;
  }

  /** Read failures/cancellation settle their caller without disabling input. */
  read<T>(
    owner: InputOwner,
    run: (job: InputJob) => Promise<T>,
    valid: () => boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new Error("Selection cancelled"));
      if (!this.lifecycle.owns(owner)) cancel();
      else {
        // A newer copy can supersede queued reads without accumulating stale
        // barriers or spending scope/selection requests on discarded results.
        for (let index = this.jobs.length - 1; index >= 0; index--) {
          const job = this.jobs[index]!;
          if (job.valid && !job.valid()) {
            job.cancel?.();
            this.jobs.splice(index, 1);
          }
        }
        this.add(
          async (job) => {
            try {
              resolve(await run(job));
            } catch (error) {
              reject(error);
            }
          },
          { barrier: true, cancel, valid },
        );
      }
    });
  }

  capture(): InputJob {
    const owner = this.lifecycle.owner;
    return {
      owner,
      request: (method, params) => this.request(owner, method, params),
      dispatch: (method, params, acknowledged) => {
        if (!this.lifecycle.owns(owner)) return;
        if (this.pending.size >= 64) {
          this.failed();
          return;
        }
        const pending = this.request(owner, method, params)
          .then(() => acknowledged?.())
          .catch((error: unknown) => {
            if (this.lifecycle.owns(owner)) this.failed(error);
          })
          .finally(() => this.pending.delete(pending));
        this.pending.add(pending);
      },
    };
  }

  text(text: string, run: QueuedJob["run"]): void {
    if (!this.lifecycle.available || !text) return;
    if (text.length > 64 * 1024) {
      this.failed();
      return;
    }
    // Each native commit may change the page's focus before the next commit.
    this.add(run, { text });
  }

  preedit(value: Preedit, run: QueuedJob["run"]): void {
    if (!this.lifecycle.available) return;
    if (value.text.length > 64 * 1024) {
      this.failed();
      return;
    }
    const tail =
      this.jobs.at(-1) ?? (this.active?.started ? null : this.active);
    if (tail?.preedit !== undefined && this.lifecycle.owns(tail.owner)) {
      tail.preedit = value;
      return;
    }
    this.add(run, { preedit: value });
  }

  discardPreedit(): void {
    const tail =
      this.jobs.at(-1) ?? (this.active?.started ? null : this.active);
    if (!tail?.preedit || !this.lifecycle.owns(tail.owner)) return;
    if (tail === this.active) tail.cancelled = true;
    else this.jobs.pop();
  }

  wheel(
    wheel: Wheel,
    run: QueuedJob["run"],
    prepare: NonNullable<QueuedJob["prepare"]>,
  ): void {
    if (!this.lifecycle.available) return;
    const tail = this.jobs.at(-1);
    const previous = tail?.wheel;
    const compatible = (a: number, b: number) =>
      !a || !b || Math.sign(a) === Math.sign(b);
    if (![wheel.deltaX, wheel.deltaY].every(Number.isFinite)) {
      this.failed();
      return;
    }
    if (
      previous &&
      tail &&
      this.lifecycle.owns(tail.owner) &&
      previous.point.x === wheel.point.x &&
      previous.point.y === wheel.point.y &&
      previous.modifiers === wheel.modifiers &&
      compatible(previous.deltaX, wheel.deltaX) &&
      compatible(previous.deltaY, wheel.deltaY)
    ) {
      const deltaX = previous.deltaX + wheel.deltaX;
      const deltaY = previous.deltaY + wheel.deltaY;
      if (![deltaX, deltaY].every(Number.isFinite)) this.failed();
      else {
        previous.deltaX = deltaX;
        previous.deltaY = deltaY;
      }
      return;
    }
    this.add(run, { wheel, prepare });
  }

  enqueue(
    run: QueuedJob["run"],
    move = false,
    prepare?: QueuedJob["prepare"],
  ): void {
    this.add(run, { move, ...(prepare ? { prepare } : {}) });
  }

  barrier(run: QueuedJob["run"]): void {
    this.add(run, { barrier: true });
  }

  private add(
    run: QueuedJob["run"],
    options: {
      move?: boolean;
      text?: string;
      preedit?: Preedit;
      wheel?: Wheel;
      prepare?: NonNullable<QueuedJob["prepare"]>;
      barrier?: boolean;
      cancel?: () => void;
      valid?: () => boolean;
    },
  ): void {
    if (!this.lifecycle.available) {
      options.cancel?.();
      return;
    }
    const { move = false, ...rest } = options;
    if (move && this.jobs.at(-1)?.move) this.jobs.pop();
    if (this.jobs.length + this.pending.size + (this.active ? 1 : 0) >= 64) {
      if (options.cancel) options.cancel();
      else this.failed();
      return;
    }
    const job: QueuedJob = {
      ...this.capture(),
      run,
      move,
      started: false,
      ...rest,
    };
    this.jobs.push(job);
    if (!this.running)
      this.drain().catch((error: unknown) => {
        if (this.lifecycle.available) this.failed(error);
      });
  }

  private async request<M extends keyof ProtocolMapping.Commands>(
    owner: InputOwner,
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    if (!this.lifecycle.owns(owner)) throw new Error("Input cancelled");
    const runtime =
      method === "Runtime.evaluate" || method === "Runtime.callFunctionOn";
    const releaseResult = (result: unknown) =>
      releaseRuntimeObjects(this.client, owner.sessionId, result);
    const result = await this.client.request(
      method,
      params,
      owner.sessionId,
      runtime ? releaseResult : undefined,
    );
    const current = this.lifecycle.owns(owner);
    // By-value and exceptional results never transfer a remote handle to the
    // job. Only a successful, current by-reference result may be retained.
    if (
      runtime &&
      (!current ||
        (isRecord(params) && params.returnByValue === true) ||
        (isRecord(result) && result.exceptionDetails !== undefined))
    )
      releaseResult(result);
    if (!current) throw new Error("Input cancelled");
    return result;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.jobs.length && this.lifecycle.available) {
        const job = this.jobs.shift()!;
        if (!this.lifecycle.owns(job.owner) || job.valid?.() === false) {
          job.cancel?.();
          continue;
        }
        this.active = job;
        try {
          if (job.barrier) await Promise.allSettled(this.pending);
          if (!this.lifecycle.owns(job.owner) || job.valid?.() === false) {
            job.cancel?.();
            continue;
          }
          // Read-only preparation may overlap scope validation. Only this
          // joined boundary permits the ordered job's state changes/writes.
          const [member] = await Promise.all([
            this.member(),
            job.prepare?.(job),
          ]);
          if (
            member &&
            this.lifecycle.owns(job.owner) &&
            job.valid?.() !== false &&
            !job.cancelled
          ) {
            job.started = true;
            await job.run(job);
          } else job.cancel?.();
        } catch (error) {
          if (job.cancel) job.cancel();
          else if (this.lifecycle.owns(job.owner)) this.failed(error);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
