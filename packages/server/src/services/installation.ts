import type {
  ClaimInstallationBody,
  InstallationStatusResponse,
} from "@cloudframe/shared";
import { hashPassphrase } from "../auth/passphrase.ts";
import {
  InstallationRepositoryError,
  type InstallationRepository,
} from "../sqlite/installation-repository.ts";

const SETUP_CODE = /^[A-Za-z0-9_-]{22}$/;

export type InstallationServiceErrorCode =
  | "CONTROL_PLANE_UNAVAILABLE"
  | "INSTALLATION_ALREADY_CONFIGURED"
  | "INVALID_PASSPHRASE"
  | "SETUP_CODE_INVALID";

export class InstallationServiceError extends Error {
  constructor(readonly code: InstallationServiceErrorCode) {
    super(code);
    this.name = "InstallationServiceError";
  }
}

export interface InstallationService {
  status(): Promise<InstallationStatusResponse>;
  claim(input: ClaimInstallationBody): Promise<{ configured: true }>;
}

export interface CreateInstallationServiceOptions {
  repository: InstallationRepository;
  passphrasePepper: string;
  now?: () => Date;
}

export function createInstallationService(
  options: CreateInstallationServiceOptions,
): InstallationService {
  const now = options.now ?? (() => new Date());

  async function status(): Promise<InstallationStatusResponse> {
    try {
      const record = await options.repository.status();
      if (!record) throw new InstallationServiceError("CONTROL_PLANE_UNAVAILABLE");
      return { state: record.configured ? "configured" : "unconfigured" };
    } catch (error) {
      throw normalize(error);
    }
  }

  async function claim(input: ClaimInstallationBody): Promise<{ configured: true }> {
    if (
      typeof input.setupCode !== "string" ||
      !SETUP_CODE.test(input.setupCode)
    ) {
      throw new InstallationServiceError("SETUP_CODE_INVALID");
    }
    if (
      typeof input.passphrase !== "string" ||
      input.passphrase.length < 16 ||
      input.passphrase.length > 1_024
    ) {
      throw new InstallationServiceError("INVALID_PASSPHRASE");
    }

    let adminPassphraseHash: string;
    try {
      adminPassphraseHash = await hashPassphrase(
        input.passphrase,
        options.passphrasePepper,
      );
    } catch {
      throw new InstallationServiceError("CONTROL_PLANE_UNAVAILABLE");
    }

    try {
      await options.repository.claim({
        setupCode: input.setupCode,
        adminPassphraseHash,
        claimedAt: now().toISOString(),
      });
      return { configured: true };
    } catch (error) {
      throw normalize(error);
    }
  }

  return { status, claim };
}

function normalize(error: unknown): InstallationServiceError {
  if (error instanceof InstallationServiceError) return error;
  if (error instanceof InstallationRepositoryError) {
    return new InstallationServiceError(error.code);
  }
  return new InstallationServiceError("CONTROL_PLANE_UNAVAILABLE");
}
