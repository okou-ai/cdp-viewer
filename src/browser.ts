/** Required native API, described locally for source consumers using ES2022 libs. */
export interface BrowserByteArrayConstructor extends Uint8ArrayConstructor {
  fromBase64(value: string): Uint8Array<ArrayBuffer>;
}

/** Client mount admission only; importing the package and SSR remain inert. */
export function assertBrowserCapabilities(): void {
  const capabilities = [
    ["AbortSignal.any", typeof globalThis.AbortSignal?.any === "function"],
    [
      "Uint8Array.fromBase64",
      typeof (Uint8Array as BrowserByteArrayConstructor).fromBase64 ===
        "function",
    ],
    ["createImageBitmap", typeof globalThis.createImageBitmap === "function"],
    ["ResizeObserver", typeof globalThis.ResizeObserver === "function"],
    [
      "IntersectionObserver",
      typeof globalThis.IntersectionObserver === "function",
    ],
    ["window.matchMedia", typeof globalThis.matchMedia === "function"],
  ] as const;
  for (const [name, available] of capabilities)
    if (!available) throw new TypeError(`cdp-viewer requires ${name}.`);
}
