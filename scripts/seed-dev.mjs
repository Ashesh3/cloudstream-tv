import { Firestore } from "@google-cloud/firestore";
import { hash, verify } from "@node-rs/argon2";
import { getVercelOidcToken } from "@vercel/oidc";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const passphrase = process.env.ADMIN_INITIAL_PASSPHRASE ?? "";
const pepper = process.env.ADMIN_PASSPHRASE_PEPPER ?? "";
const householdId = process.env.HOUSEHOLD_ID ?? "";

validatePassphrase(passphrase);
if (!pepper) throw new Error("ADMIN_PASSPHRASE_PEPPER is required");
if (!householdId) throw new Error("HOUSEHOLD_ID is required");

const plan = {
  operation: "create-if-absent",
  householdId,
  allowNewDeviceRequests: true,
  defaultMediaOrder: "captured-desc",
  defaultSlideshowSeconds: 8
};

if (dryRun) {
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} else {
  const firestore = createFirestore();
  const reference = firestore.collection("households").doc(householdId);
  const result = await firestore.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists) {
      const current = snapshot.data();
      if (!current?.adminPassphraseHash) {
        throw new Error("Existing household is missing its passphrase hash");
      }
      if (!(await verify(current.adminPassphraseHash, passphrase, {
        secret: Buffer.from(pepper, "utf8")
      }))) {
        throw new Error("Existing household passphrase does not match");
      }
      return "unchanged";
    }
    const adminPassphraseHash = await hash(passphrase, {
      algorithm: 2,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
      secret: Buffer.from(pepper, "utf8")
    });
    transaction.create(reference, {
      id: householdId,
      createdAt: new Date(),
      allowNewDeviceRequests: true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8,
      adminPassphraseHash,
      adminPassphraseVersion: 1
    });
    return "created";
  });
  process.stdout.write(`${JSON.stringify({ ...plan, result })}\n`);
}

function validatePassphrase(value) {
  if (value.length < 16) {
    throw new Error("ADMIN_INITIAL_PASSPHRASE must be at least 16 characters");
  }
  if (/^(.)\1+$/.test(value) || /^(password|passphrase|admin|cloudframe)/i.test(value)) {
    throw new Error("ADMIN_INITIAL_PASSPHRASE must not be a common or repeated value");
  }
}

function createFirestore() {
  const projectId = required("FIRESTORE_PROJECT_ID");
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return new Firestore({ projectId, databaseId, host: process.env.FIRESTORE_EMULATOR_HOST, ssl: false });
  }
  const provider = required("GCP_WORKLOAD_IDENTITY_PROVIDER").replace(/^\/\/iam\.googleapis\.com\//, "");
  const serviceAccount = required("GCP_SERVICE_ACCOUNT_EMAIL");
  return new Firestore({
    projectId,
    databaseId,
    credentials: {
      type: "external_account",
      audience: `//iam.googleapis.com/${provider}`,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url:
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`,
      subject_token_supplier: { getSubjectToken: getVercelOidcToken }
    }
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
