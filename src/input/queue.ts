import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient } from "../cdp/client";
import { isRecord } from "../cdp/errors";
import { releaseRuntimeObjects } from "../cdp/runtime-objects";
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
  prepare?: (job: InputJob) => Promise<void>;
  barrier?: boolean;
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
    this.jobs.length = 0;
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
      wheel?: Wheel;
      prepare?: NonNullable<QueuedJob["prepare"]>;
      barrier?: boolean;
    },
  ): void {
    if (!this.lifecycle.available) return;
    const { move = false, ...rest } = options;
    if (move && this.jobs.at(-1)?.move) this.jobs.pop();
    if (this.jobs.length + this.pending.size + (this.active ? 1 : 0) >= 64) {
      this.failed();
      return;
    }
    const job: QueuedJob = {
      ...this.capture(),
      run,
      move,
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
        if (!this.lifecycle.owns(job.owner)) continue;
        this.active = job;
        try {
          if (job.barrier) await Promise.allSettled(this.pending);
          if (!this.lifecycle.owns(job.owner)) continue;
          // Read-only preparation may overlap scope validation. Only this
          // joined boundary permits the ordered job's state changes/writes.
          const [member] = await Promise.all([
            this.member(),
            job.prepare?.(job),
          ]);
          if (member && this.lifecycle.owns(job.owner)) await job.run(job);
        } catch (error) {
          if (this.lifecycle.owns(job.owner)) this.failed(error);
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
