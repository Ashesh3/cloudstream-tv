import { createHmac } from "node:crypto";

export function csrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`admin-csrf\u0000${sessionId}`)
    .digest("hex");
}
