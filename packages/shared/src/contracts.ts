export type EntityId = string;
export type MediaOrder = "captured-desc" | "captured-asc" | "name-asc";
export type ProviderKind = "google" | "onedrive";
export type DeviceRequestStatus = "pending" | "approved" | "denied" | "expired";

export interface EncryptedSecret {
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}
