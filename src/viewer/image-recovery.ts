import type { ViewerError } from "./types";

export type ImageRecovery = {
  readonly owner: object;
  readonly targetId: string;
  readonly error: ViewerError;
  readonly phase:
    | "settling"
    | "ready"
    | "preparing"
    | "starting"
    | "waiting-image"
    | "presented"
    | "blocked";
};

export type ImageEvent =
  | {
      readonly type: "image-failed";
      readonly owner: object;
      readonly targetId: string;
      readonly error: ViewerError;
    }
  | {
      readonly type: "image-settled";
      readonly owner: object;
      readonly ready: boolean;
    }
  | {
      readonly type: "image-blocked";
      readonly owner: object;
      readonly error: ViewerError;
    }
  | {
      readonly type:
        | "image-retrying"
        | "image-starting"
        | "image-painted"
        | "image-released";
      readonly owner: object;
    }
  | {
      readonly type: "image-cancelled";
      readonly owner: object;
      readonly stopped: boolean;
    };

export interface ImageDecision {
  readonly state: ImageRecovery | null;
  readonly accepted: boolean;
  readonly imageReady: boolean;
  readonly resumeDisplay: boolean;
}

export function retryingImage(image: ImageRecovery | null): boolean {
  return (
    image?.phase === "preparing" ||
    image?.phase === "starting" ||
    image?.phase === "waiting-image"
  );
}

/** Pure recovery decisions; native receipts and the capture lane remain resource-owned. */
export function transitionImage(
  image: ImageRecovery | null,
  event: ImageEvent,
): ImageDecision {
  const ignored: ImageDecision = {
    state: image,
    accepted: false,
    imageReady: false,
    resumeDisplay: false,
  };
  const accept = (
    state: ImageRecovery | null,
    imageReady = false,
    resumeDisplay = false,
  ): ImageDecision => ({ state, accepted: true, imageReady, resumeDisplay });
  if (event.type === "image-failed")
    return accept({
      owner: event.owner,
      targetId: event.targetId,
      error: event.error,
      phase: "settling",
    });
  if (!image || image.owner !== event.owner) return ignored;
  switch (event.type) {
    case "image-settled":
      return image.phase === "settling"
        ? accept({ ...image, phase: event.ready ? "ready" : "blocked" })
        : ignored;
    case "image-retrying":
      return image.phase === "ready"
        ? accept({ ...image, phase: "preparing" })
        : ignored;
    case "image-starting":
      return image.phase === "preparing"
        ? accept({ ...image, phase: "starting" })
        : ignored;
    case "image-painted":
      if (image.phase === "starting")
        return accept({ ...image, phase: "presented" }, true);
      return image.phase === "waiting-image"
        ? accept(null, true, true)
        : ignored;
    case "image-released":
      if (image.phase === "starting")
        return accept({ ...image, phase: "waiting-image" });
      return image.phase === "presented" ? accept(null, false, true) : ignored;
    case "image-blocked":
      return retryingImage(image) || image.phase === "presented"
        ? accept({ ...image, phase: "blocked", error: event.error })
        : ignored;
    case "image-cancelled":
      // Settling still needs every original receipt, even if capture alone stopped.
      return retryingImage(image) || image.phase === "presented"
        ? accept({ ...image, phase: event.stopped ? "ready" : "blocked" })
        : ignored;
  }
}
