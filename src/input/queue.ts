import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient } from "../cdp/client";
import { isRecord } from "../cdp/errors";
import type { InputLifecycle, InputOwner } from "./lifecycle";

export interface InputJob {
  readonly owner: InputOwner;
  text?: string;
  request<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
}

interface QueuedJob extends InputJob {
  run: (job: InputJob) => Promise<void>;
  move: boolean;
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

  text(text: string, run: QueuedJob["run"]): void {
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
    } else this.enqueue(run, false, text);
  }

  enqueue(run: QueuedJob["run"], move = false, text?: string): void {
    if (!this.lifecycle.available) return;
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
      ...(text === undefined ? {} : { text }),
      request: (method, params) => {
        // Arguments capture the payload now. Later text belongs to a new job,
        // even while this write is awaiting acknowledgement.
        if (method === "Input.insertText" && this.collecting === job)
          this.collecting = null;
        return this.request(owner, method, params);
      },
    };
    this.jobs.push(job);
    if (!this.running) void this.drain();
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
          if ((await this.member()) && this.lifecycle.owns(job.owner))
            await job.run(job);
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
