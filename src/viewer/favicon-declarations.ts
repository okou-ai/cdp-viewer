import { isRecord } from "../cdp/errors";

interface IconCandidate {
  readonly url: string;
  readonly size: number;
  readonly fallback?: boolean;
}

export interface IconDeclarations {
  readonly url: string;
  readonly candidates: readonly IconCandidate[];
}

/** Runs in a remote isolated world. Keep all dependencies inside this function. */
function pageIcons() {
  const candidates: { url: string; size: number }[] = [];
  const links = document.querySelectorAll<HTMLLinkElement>(
    'link[rel~="icon" i]',
  );
  for (let i = links.length - 1; i >= Math.max(0, links.length - 32); i--) {
    const link = links[i]!;
    if (link.media && !matchMedia(link.media).matches) continue;
    if (!link.getAttribute("href")) continue;
    const url = new URL(link.href, document.baseURI);
    if (!["http:", "https:", "data:"].includes(url.protocol)) continue;
    if (url.href.length > 16_384) continue;
    const sizes = link.sizes.value.toLowerCase().split(/\s+/);
    const values = sizes.flatMap((size) => {
      const match = /^(\d+)x\1$/.exec(size);
      return match ? [Number(match[1])] : [];
    });
    const size = sizes.includes("any")
      ? 0
      : values.length
        ? values.sort((a, b) => {
            const score = (n: number) => (n >= 16 ? n - 16 : 10_000 + 16 - n);
            return score(a) - score(b);
          })[0]!
        : -1;
    if (!candidates.some((candidate) => candidate.url === url.href))
      candidates.push({ url: url.href, size });
    if (candidates.length === 8) break;
  }
  return { url: location.href, candidates };
}

export const iconExpression = `(${pageIcons.toString()})()`;

/** Lower scores prefer scalable, exact, then larger, unspecified and smaller. */
export function iconScore(size: number): number {
  if (size === 0) return 0;
  if (size === 16) return 1;
  if (size > 16) return 2 + (size - 16) / size;
  if (size < 0) return 3;
  return 4 + (16 - size) / 16;
}

export function parseIcons(raw: unknown): IconDeclarations | null {
  if (
    !isRecord(raw) ||
    typeof raw.url !== "string" ||
    raw.url.length > 16_384 ||
    !Array.isArray(raw.candidates) ||
    raw.candidates.length > 8
  )
    return null;
  const candidates: IconCandidate[] = [];
  for (const value of raw.candidates as unknown[]) {
    if (
      !isRecord(value) ||
      typeof value.url !== "string" ||
      value.url.length > 16_384 ||
      typeof value.size !== "number" ||
      !Number.isFinite(value.size) ||
      value.size < -1
    )
      return null;
    const url = new URL(value.url);
    if (!["http:", "https:", "data:"].includes(url.protocol)) continue;
    candidates.push({ url: url.href, size: value.size });
  }
  candidates.sort((a, b) => iconScore(a.size) - iconScore(b.size));
  const page = new URL(raw.url);
  if (["http:", "https:"].includes(page.protocol)) {
    const fallback = new URL("/favicon.ico", page).href;
    if (!candidates.some((candidate) => candidate.url === fallback))
      candidates.push({ url: fallback, size: -1, fallback: true });
  }
  return { url: raw.url, candidates };
}
