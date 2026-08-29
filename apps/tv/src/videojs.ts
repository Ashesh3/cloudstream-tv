type VideoJsImporter = () => Promise<unknown>;

export function createVideoJsLoader(
  importer: VideoJsImporter = () => import("@videojs/html/video/player"),
): () => Promise<boolean> {
  let loading: Promise<boolean> | null = null;
  return () => {
    if (loading) return loading;
    loading = importer()
      .then(() =>
        typeof customElements !== "undefined" &&
        Boolean(customElements.get("video-player")) &&
        Boolean(customElements.get("media-container"))
      )
      .catch(() => false);
    return loading;
  };
}

export const loadVideoJs = createVideoJsLoader();
