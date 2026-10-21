import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient } from "../cdp/client";
import { isRecord } from "../cdp/errors";
import type { InputLifecycle, InputOwner } from "./lifecycle";
import type { Point } from "./geometry";

interface Wheel {
  point: Point;
  modifiers: number;
  deltaX: number;
  deltaY: number;
}

export interface InputJob {
  readonly owner: InputOwner;
  text?: string;
  wheel?: Wheel;
  request<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
}

interface QueuedJob extends InputJob {
  run: (job: InputJob) => Promise<void>;
  move: boolean;
  prepare?: (job: InputJob) => Promise<void>;
}

/** One serial lane; each request closes over its job's immutable owner. */
export class InputQueue {
  private readonly jobs: QueuedJob[] = [];
  private running = false;
  private collecting: QueuedJob | null = null;

  constructor(
    private readonly client: CdpClient,
    private readonly lifecycle: InputLifecycle,
    private readonly member: () => Promise<boolean>,
    private readonly failed: (error?: unknown) => void,
  ) {}

  clear(): void {
    this.jobs.length = 0;
    this.collecting = null;
  }

  text(
    text: string,
    run: QueuedJob["run"],
    prepare?: QueuedJob["prepare"],
  ): void {
    if (!this.lifecycle.available || !text) return;
    if (text.length > 64 * 1024) {
      this.failed();
      return;
    }
    const tail = this.jobs.at(-1) ?? this.collecting;
    if (
      tail?.text !== undefined &&
      this.lifecycle.owns(tail.owner) &&
      tail.text.length + text.length <= 64 * 1024
    ) {
      tail.text += text;
    } else this.add(run, { text, ...(prepare ? { prepare } : {}) });
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

  private add(
    run: QueuedJob["run"],
    options: {
      move?: boolean;
      text?: string;
      wheel?: Wheel;
      prepare?: NonNullable<QueuedJob["prepare"]>;
    },
  ): void {
    if (!this.lifecycle.available) return;
    const { move = false, ...rest } = options;
    if (move && this.jobs.at(-1)?.move) this.jobs.pop();
    if (this.jobs.length >= 64) {
      this.failed();
      return;
    }
    const owner = this.lifecycle.owner;
    const job: QueuedJob = {
      owner,
      run,
      move,
      ...rest,
      request: (method, params) => {
        // Arguments capture the payload now. Later text belongs to a new job,
        // even while this write is awaiting acknowledgement.
        if (method === "Input.insertText" && this.collecting === job)
          this.collecting = null;
        return this.request(owner, method, params);
      },
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
    const releaseResult = (result: unknown) => {
      if (!isRecord(result)) return;
      const objects = [
        result.result,
        isRecord(result.exceptionDetails)
          ? result.exceptionDetails.exception
          : undefined,
      ];
      const ids = new Set<string>();
      for (const object of objects)
        if (isRecord(object) && typeof object.objectId === "string")
          ids.add(object.objectId);
      for (const objectId of ids)
        this.client.notify(
          "Runtime.releaseObject",
          { objectId },
          owner.sessionId,
        );
    };
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
        this.collecting = job.text === undefined ? null : job;
        try {
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
          if (this.collecting === job) this.collecting = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
