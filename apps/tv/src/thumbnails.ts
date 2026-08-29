export interface ThumbnailCandidate {
  id: string;
  handle: string;
  kind: "folder" | "image" | "video";
  hasPreview: boolean;
}

export type ThumbnailRequestState = Record<
  string,
  { requestedHandle: string } | undefined
>;

const MAX_THUMBNAIL_HANDLES = 100;
export const DEFAULT_THUMBNAIL_REQUEST_BYTES = 30 * 1_024;

export function thumbnailRequestBatches<T extends ThumbnailCandidate>(
  items: readonly T[],
  state: ThumbnailRequestState,
  maxBytes = DEFAULT_THUMBNAIL_REQUEST_BYTES,
): T[][] {
  const requested = items.filter((item) =>
    (item.kind === "folder" || item.hasPreview) &&
    state[item.id]?.requestedHandle !== item.handle
  );
  const batches: T[][] = [];
  let batch: T[] = [];

  for (const item of requested) {
    const candidate = [...batch, item];
    if (
      batch.length > 0 &&
      (candidate.length > MAX_THUMBNAIL_HANDLES ||
        thumbnailRequestBytes(candidate) > maxBytes)
    ) {
      batches.push(batch);
      batch = [item];
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function thumbnailRequestBytes(items: readonly ThumbnailCandidate[]): number {
  const body = JSON.stringify({
    handles: items.map((item) => item.handle),
    maxDimension: 720,
  });
  return new TextEncoder().encode(body).byteLength;
}

interface WarmImage {
  referrerPolicy: string;
  src: string;
  onload: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface ThumbnailWarmer {
  warm(url: string): boolean;
  clear(): void;
  retainedCount(): number;
}

export function createThumbnailWarmer(
  createImage: () => WarmImage = () => new Image(),
): ThumbnailWarmer {
  const seen = new Set<string>();
  const retained = new Map<string, WarmImage>();

  return {
    warm(url) {
      if (seen.has(url)) return false;
      seen.add(url);
      const image = createImage();
      retained.set(url, image);
      const release = () => {
        image.onload = null;
        image.onerror = null;
        retained.delete(url);
      };
      image.onload = release;
      image.onerror = release;
      image.referrerPolicy = "no-referrer";
      image.src = url;
      return true;
    },
    clear() {
      retained.forEach((image) => {
        image.onload = null;
        image.onerror = null;
      });
      retained.clear();
      seen.clear();
    },
    retainedCount() {
      return retained.size;
    },
  };
}
