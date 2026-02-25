export function validateEnv() {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "ONEDRIVE_CLIENT_ID",
    "ONEDRIVE_CLIENT_SECRET",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
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
