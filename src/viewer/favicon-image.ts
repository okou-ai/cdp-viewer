export interface FaviconImage {
  readonly src: string;
  readonly size: number;
}

/** Rasterize remote bytes so the host never loads a remote page's image URL. */
export async function decodeFavicon(
  blob: Blob,
  signal: AbortSignal,
): Promise<FaviconImage> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const cancel = () => image.removeAttribute("src");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height || width > 2048 || height > 2048)
      throw new Error("Unsupported icon dimensions.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Icon decoding unavailable.");
    const scale = 32 / Math.max(width, height);
    context.drawImage(
      image,
      (32 - width * scale) / 2,
      (32 - height * scale) / 2,
      width * scale,
      height * scale,
    );
    return {
      src: canvas.toDataURL("image/png"),
      size: blob.type === "image/svg+xml" ? 0 : Math.max(width, height),
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
