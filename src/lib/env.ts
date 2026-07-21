export function validateEnv() {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ONEDRIVE_CLIENT_ID",
    "ONEDRIVE_CLIENT_SECRET",
    // Storage is Vercel Blob. On Vercel, auth is secretless via
    // VERCEL_OIDC_TOKEN + BLOB_STORE_ID (both auto-injected); locally a
    // BLOB_READ_WRITE_TOKEN is used instead. BLOB_STORE_ID is the one
    // consistently present, so we surface it as the storage requirement.
    "BLOB_STORE_ID",
    "NEXT_PUBLIC_APP_URL",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.warn(
      `Missing environment variables: ${missing.join(", ")}. Some features may not work.`
    );
  }

  return missing.length === 0;
}
