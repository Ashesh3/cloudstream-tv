export function isLegacyMpeg(value: { name: string; mimeType: string | null }): boolean {
  return value.mimeType?.toLowerCase() === "video/mpeg" || /\.(?:mpg|mpeg|dat)$/i.test(value.name);
}
