import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient } from "../cdp/client";
import { CdpFault } from "../cdp/errors";

type Method = keyof ProtocolMapping.Commands;
type Params<M extends Method> = ProtocolMapping.Commands[M]["paramsType"][0];
type Result<M extends Method> = ProtocolMapping.Commands[M]["returnType"];
type Outcome<T> = { ok: true; result: T } | { ok: false; error: unknown };

/** Original-session effects retain their acknowledgement even after owner loss. */
export class InputEffects {
  private readonly pending = new Set<Promise<void>>();
  private failed = false;
  private imeSupported = false;
  private imeUnsupported = false;

  constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
  ) {}

  request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.issue(method, params).receipt.then((outcome) => {
      if (!outcome.ok) throw outcome.error;
      return outcome.result;
    });
  }

  notify<M extends Method>(method: M, params: Params<M>): void {
    // The owned, non-rejecting receipt remains in pending until completion.
    this.issue(method, params);
  }

  private issue<M extends Method>(
    method: M,
    params: Params<M>,
  ): { receipt: Promise<Outcome<Result<M>>> } {
    if (this.pending.size >= 128) {
      this.failed = true;
      const error = new CdpFault("input", "Too many pending input effects.");
      this.client.close(error);
      return { receipt: Promise.resolve({ ok: false, error }) };
    }
    const receipt = this.client.request(method, params, this.sessionId).then(
      (result): Outcome<Result<M>> => ({ ok: true, result }),
      (error: unknown): Outcome<Result<M>> => ({ ok: false, error }),
    );
    const settled = receipt
      .then((outcome) => {
        if (outcome.ok) {
          if (method === "Input.imeSetComposition") this.imeSupported = true;
        } else {
          const unsupported =
            method === "Input.imeSetComposition" &&
            outcome.error instanceof CdpFault &&
            outcome.error.code === -32601;
          if (unsupported) this.imeUnsupported = true;
          else this.failed = true;
        }
      })
      .finally(() => this.pending.delete(settled));
    this.pending.add(settled);
    return { receipt };
  }

  async completion(): Promise<void> {
    await Promise.all(this.pending);
    // Replies may arrive out of order: an early unsupported cleanup cannot
    // become success if a later reply confirms original IME support.
    if (this.failed || (this.imeSupported && this.imeUnsupported))
      throw new CdpFault("input", "Original input cleanup is unconfirmed.");
  }
}
