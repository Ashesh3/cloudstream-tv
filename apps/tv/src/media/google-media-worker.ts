declare const __CLOUDFRAME_MEDIA_PROBE_ORIGIN__: string | null;

import { googleMediaFingerprint, isExactGoogleMediaUrl } from "./google-media-protocol";
import { installGoogleMediaWorker } from "./google-media-worker-runtime";

const isAllowedMediaUrl = __CLOUDFRAME_MEDIA_PROBE_ORIGIN__ === null
  ? isExactGoogleMediaUrl
  : (value: string) => {
      try {
        const url = new URL(value);
        return url.origin === __CLOUDFRAME_MEDIA_PROBE_ORIGIN__ &&
          url.pathname === "/sample.wav" && url.search === "" && url.hash === "";
      } catch {
        return false;
      }
    };

installGoogleMediaWorker(self as unknown as Parameters<typeof installGoogleMediaWorker>[0], {
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  fingerprint: googleMediaFingerprint,
  isAllowedMediaUrl,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});
