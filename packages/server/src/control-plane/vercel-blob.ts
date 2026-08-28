import {
  BlobPreconditionFailedError,
  get,
  put,
  type GetCommandOptions,
  type PutCommandOptions
} from "@vercel/blob";

import type { ControlPlaneEnvelopeV1 } from "./envelope.ts";
import {
  ControlPlaneStoreError,
  type ControlDurableStore
} from "./store.ts";

export interface VercelBlobControlStoreOptions {
  environment: string;
  householdId: string;
  storeId?: string;
}

function pathname(options: VercelBlobControlStoreOptions): string {
  return `cloudframe/control-plane/${options.environment}/${options.householdId}.json.enc`;
}

function blobIdentityOptions(
  storeId: string | undefined
): Pick<GetCommandOptions, "storeId"> {
  return storeId === undefined ? {} : { storeId };
}

function writeOptions(
  storeId: string | undefined,
  ifMatch?: string
): PutCommandOptions {
  return {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    ifMatch,
    ...blobIdentityOptions(storeId)
  };
}

export function createVercelBlobControlStore(
  options: VercelBlobControlStoreOptions
): ControlDurableStore {
  const controlPathname = pathname(options);

  return {
    async read(ifNoneMatch) {
      const result = await get(controlPathname, {
        access: "private",
        useCache: false,
        ifNoneMatch,
        ...blobIdentityOptions(options.storeId)
      });
      if (result === null) {
        return null;
      }
      if (result.statusCode === 304) {
        return { notModified: true };
      }

      const envelope = await new Response(result.stream).json() as ControlPlaneEnvelopeV1;
      return { envelope, etag: result.blob.etag };
    },

    async create(envelope) {
      const result = await put(
        controlPathname,
        JSON.stringify(envelope),
        writeOptions(options.storeId)
      );
      return { etag: result.etag };
    },

    async replace(envelope, expectedEtag) {
      try {
        const result = await put(
          controlPathname,
          JSON.stringify(envelope),
          writeOptions(options.storeId, expectedEtag)
        );
        return { etag: result.etag };
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) {
          throw new ControlPlaneStoreError("CONTROL_PLANE_CONFLICT");
        }
        throw error;
      }
    }
  };
}
