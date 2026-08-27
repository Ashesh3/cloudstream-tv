import type { Source } from "@cloudframe/shared";

import { decodeFirestoreValue } from "./repository";

export function decodeSourceDocument(
  id: string,
  data: Record<string, unknown> | undefined
): Source {
  const decoded = decodeFirestoreValue({ ...data, id }) as Omit<
    Source,
    "providerRootId"
  > & { providerRootId?: string | null };
  return { ...decoded, providerRootId: decoded.providerRootId ?? null };
}
