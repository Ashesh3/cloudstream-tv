import type { MediaNode } from "@cloudframe/shared";

export interface ReconciliationRepository {
  reconcileSourceGeneration(input: {
    sourceId: string;
    generation: string;
    cursor: string | null;
    limit: number;
    now: Date;
    leaseOwner: string;
  }): Promise<{ nodes: MediaNode[]; nextCursor: string | null }>;
}

export async function runReconciliationBatch(input: {
  repository: ReconciliationRepository;
  sourceId: string;
  generation: string;
  now: Date;
  cursor?: string | null;
  limit?: number;
  leaseOwner: string;
}) {
  const limit = Math.max(1, Math.min(200, input.limit ?? 200));
  const result = await input.repository.reconcileSourceGeneration({
    sourceId: input.sourceId,
    generation: input.generation,
    cursor: input.cursor ?? null,
    limit,
    now: input.now,
    leaseOwner: input.leaseOwner
  });
  return {
    processed: result.nodes.length,
    nextCursor: result.nextCursor,
    complete: result.nextCursor === null
  };
}
