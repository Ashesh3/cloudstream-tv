type VideoJsImporter = () => Promise<unknown>;
type CustomElementRegistryReader = Pick<CustomElementRegistry, "get">;

export function createVideoJsLoader(
  importer: VideoJsImporter = async () => {
    await Promise.all([
      import("@videojs/html/video/player"),
      import("@videojs/html/ui/container"),
    ]);
  },
  registry: CustomElementRegistryReader | undefined = globalThis.customElements,
): () => Promise<boolean> {
  let loading: Promise<boolean> | null = null;
  return () => {
    if (loading) return loading;
    loading = importer()
      .then(() =>
        Boolean(registry?.get("video-player")) &&
        Boolean(registry?.get("media-container"))
      )
      .catch(() => false);
    return loading;
  };
}

export const loadVideoJs = createVideoJsLoader();
