import type { ProviderRegistry } from "@cloudframe/providers";
import type { ControlPlaneStore } from "../control-plane/store.ts";
import { loadControlRequestContext, type ControlRequestContextScope } from "../http/request-context.ts";
import type { AuthenticatedControlDevice } from "../services/control-auth.ts";
import type { CredentialBroker } from "../services/credential-broker.ts";
import { LiveBrowseError, type AuthorizedBrowseItem } from "../services/live-browse.ts";
import { TranscodeError, type TranscodeSourceBinding } from "./types.ts";

export interface AuthorizedTranscodeSource {
  auth: AuthenticatedControlDevice;
  item: AuthorizedBrowseItem;
  binding: TranscodeSourceBinding;
}

export interface TranscodeSourceAuthorizer {
  bind(auth: AuthenticatedControlDevice, item: AuthorizedBrowseItem): AuthorizedTranscodeSource;
  validateCurrent(auth: AuthenticatedControlDevice, binding: TranscodeSourceBinding): AuthorizedBrowseItem;
  withReauthorizedItem<T>(binding: TranscodeSourceBinding, operation: (item: AuthorizedBrowseItem) => Promise<T>): Promise<T>;
}

export function createTranscodeSourceAuthorizer(options: {
  controlStore: ControlPlaneStore;
  requestContext: ControlRequestContextScope;
  credentialBroker: CredentialBroker;
  providers: ProviderRegistry;
  now?: () => Date;
}): TranscodeSourceAuthorizer {
  function bind(auth: AuthenticatedControlDevice, item: AuthorizedBrowseItem): AuthorizedTranscodeSource {
    if (item.claims.kind !== "video" || (item.claims.contentRevision === null && item.claims.size === null)) throw new TranscodeError("TRANSCODER_UNSUPPORTED");
    if (item.claims.deviceId !== auth.deviceId || item.claims.householdId !== auth.householdId || item.root.id !== item.claims.rootId || item.source.id !== item.claims.sourceId) throw new LiveBrowseError("ITEM_NOT_FOUND");
    const binding: TranscodeSourceBinding = {
      householdId: auth.householdId,
      deviceId: auth.deviceId,
      deviceSessionVersion: auth.sessionVersion,
      sourceId: item.source.id,
      rootId: item.root.id,
      rootProviderNodeId: item.root.providerNodeId,
      providerNodeId: item.claims.providerNodeId,
      provider: item.source.provider,
      itemId: item.id,
      name: item.claims.name,
      mimeType: item.claims.mimeType,
      size: item.claims.size,
      contentRevision: item.claims.contentRevision,
      credentialVersion: item.claims.credentialVersion,
    };
    validateCurrent(auth, binding);
    return { auth, item, binding };
  }

  function validateCurrent(auth: AuthenticatedControlDevice, binding: TranscodeSourceBinding): AuthorizedBrowseItem {
    const context = auth.context;
    const device = context.document.devices[binding.deviceId];
    if (context.revision !== context.document.revision || auth.householdId !== binding.householdId || auth.deviceId !== binding.deviceId || !device || !device.enabled || device.revokedAt !== null || device.sessionVersion !== binding.deviceSessionVersion || auth.sessionVersion !== binding.deviceSessionVersion) throw new LiveBrowseError("DEVICE_UNAUTHORIZED");
    const root = context.document.roots[binding.rootId];
    if (!root || !root.enabled || !device.assignedRootIds.includes(root.id) || root.sourceId !== binding.sourceId || root.providerNodeId !== binding.rootProviderNodeId) throw new LiveBrowseError("ITEM_NOT_FOUND");
    const source = context.document.sources[binding.sourceId];
    if (!source || source.status !== "healthy" || source.provider !== binding.provider) throw new LiveBrowseError("ITEM_NOT_FOUND");
    if (source.credentialVersion !== binding.credentialVersion) throw new LiveBrowseError("NAVIGATION_EXPIRED");
    return {
      id: binding.itemId,
      root,
      source,
      claims: {
        version: 2,
        householdId: binding.householdId,
        deviceId: binding.deviceId,
        sourceId: binding.sourceId,
        rootId: binding.rootId,
        rootProviderNodeId: binding.rootProviderNodeId,
        providerNodeId: binding.providerNodeId,
        parentProviderNodeId: binding.rootProviderNodeId,
        kind: "video",
        name: binding.name,
        mimeType: binding.mimeType,
        size: binding.size,
        contentRevision: binding.contentRevision,
        preview: null,
        credentialVersion: binding.credentialVersion,
        issuedAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    };
  }

  async function withReauthorizedItem<T>(binding: TranscodeSourceBinding, operation: (item: AuthorizedBrowseItem) => Promise<T>): Promise<T> {
    return options.requestContext.runRequest(async () => {
      const context = await loadControlRequestContext(options.controlStore, options.requestContext);
      const currentDevice = context.document.devices[binding.deviceId];
      const auth: AuthenticatedControlDevice = {
        householdId: binding.householdId,
        deviceId: binding.deviceId,
        sessionVersion: binding.deviceSessionVersion,
        device: currentDevice ? structuredClone(currentDevice) : ({} as never),
        context,
      };
      const item = validateCurrent(auth, binding);
      const credentials = await options.credentialBroker.get(binding.sourceId, binding.householdId);
      if (credentials.credentialVersion !== binding.credentialVersion) throw new LiveBrowseError("NAVIGATION_EXPIRED");
      const node = await options.providers.get(binding.provider).getNode({ credentials, providerNodeId: binding.providerNodeId });
      if (node.kind !== "video" || (binding.contentRevision !== null && node.contentRevision !== binding.contentRevision) || (binding.size !== null && node.size !== binding.size)) throw new LiveBrowseError("NAVIGATION_EXPIRED");
      return operation(item);
    });
  }

  return { bind, validateCurrent, withReauthorizedItem };
}
