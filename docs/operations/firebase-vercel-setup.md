# Firebase and Vercel operations

## Current development resources

| Resource | Value |
|---|---|
| GCP/Firebase project | `cloudframe-tv-dev` (`7371742203`) |
| Firestore | Native `(default)`, `asia-south1` |
| Vercel team/project | `ashsec` / `tv-video-ui` |
| Vercel project ID | `prj_CFOxdTl9iBsESvS1sjnyWkh7MxEr` |
| Vercel function region | `bom1` |
| Service account | `cloudframe-vercel-dev@cloudframe-tv-dev.iam.gserviceaccount.com` |
| WIF pool/provider | `vercel` / `vercel-ashsec` |

Firestore currently reports `freeTier=true`. Linking billing account `01DA89-86590E-2EA187` failed with **Cloud billing quota exceeded** because that account has reached its linked-project quota. Do not unlink unrelated projects. Request a billing-project quota increase or link a different approved billing account before treating this as a Blaze project.

## Firebase configuration

Only Firestore is enabled. Firebase Authentication, Storage, Hosting, and Functions are intentionally unused.

```powershell
firebase use dev
firebase deploy --only firestore:rules,firestore:indexes
```

Validate after deployment:

```powershell
gcloud firestore databases describe --database='(default)' --project=cloudframe-tv-dev
firebase firestore:indexes --project cloudframe-tv-dev
```

`firestore.rules` denies all browser access. Server IAM bypasses client rules. The service account has only `roles/datastore.user` and `roles/serviceusage.serviceUsageConsumer`, and it has no user-managed keys.

Current verified state: deny-all ruleset `f3abd42b...` is deployed, all five composite indexes are READY, and a live dev Vercel OIDC -> Google STS -> service-account impersonation -> Firestore exchange passed under the exact preview/development subject condition.

For a disposable emulator smoke:

```powershell
firebase emulators:exec --only firestore "npm test"
```

Do not point tests at the live database unless documents use a disposable prefix and are removed in a `finally` block.

## Vercel OIDC to Google WIF

Issuer and audience:

```text
issuer:   https://oidc.vercel.com/ashsec
audience: https://vercel.com/ashsec
provider: projects/7371742203/locations/global/workloadIdentityPools/vercel/providers/vercel-ashsec
```

Impersonation is limited to these exact Vercel subjects:

```text
owner:ashsec:project:tv-video-ui:environment:preview
owner:ashsec:project:tv-video-ui:environment:development
```

No JSON service-account key is permitted. Validate the deployed preview by calling an authenticated endpoint that reads Firestore and confirming Google IAM audit logs show service-account impersonation from the expected principal.

## Environment inventory

Configure Development and Preview (`dev` branch) without printing values:

```text
APP_ORIGIN
NEXT_PUBLIC_APP_URL
HOUSEHOLD_ID
FIRESTORE_PROJECT_ID
FIRESTORE_DATABASE_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT_EMAIL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
ONEDRIVE_CLIENT_ID
ONEDRIVE_CLIENT_SECRET
ONEDRIVE_TENANT
ADMIN_INITIAL_PASSPHRASE
ADMIN_PASSPHRASE_PEPPER
CSRF_SECRET
BROWSE_CURSOR_SECRET
PROVIDER_TOKEN_KEY_VERSION
PROVIDER_TOKEN_KEY_V1
CRON_SECRET
```

Keep `FIRESTORE_EMULATOR_HOST` local only. `WORKFLOW_QUEUE_NAMESPACE` must be absent in every Vercel environment while using stable Workflow SDK 4.8.5; the stable runtime publishes step messages to the default `__wkf_step_*` topic.

The current dev bootstrap passphrase is stored with a user-only ACL at `C:\Users\Ashesh\.cloudframe-tv-dev-bootstrap.txt`. Rotate it after first login. Never paste it into tickets, logs, git, or chat.

## OAuth redirects

After the first `dev` deployment, verify its alias and configure both provider consoles with exactly:

```text
https://tv-video-ui-git-dev-ashsec.vercel.app/api/admin/oauth/google/callback
https://tv-video-ui-git-dev-ashsec.vercel.app/api/admin/oauth/onedrive/callback
```

The callback host must equal `APP_ORIGIN`; do not accept an arbitrary redirect URI from the browser. Google needs Drive read-only/offline access. Microsoft needs `Files.Read`/`Files.Read.All` as approved plus `offline_access`. Provider-console redirect changes remain a manual external action until authenticated console access is available.

## Build and deployment

Vercel Framework Preset must be **Other** (not Next.js), with:

```text
Build command: npm run build:vercel
Output directory: .vercel/output
Install command: npm install
Node: 24.x
```

The remote project was configured to **Other**, but a stale local `.vercel/project.json` may still say `nextjs`. Run `vercel pull --yes` after linking; if `vercel build` reports `NEXT_NO_VERSION`, recheck the remote preset and pull again.

Then:

```powershell
vercel pull --yes --environment=preview
npm run build:vercel
vercel deploy --prebuilt --target=preview
```

Probe the returned URL:

```powershell
Invoke-WebRequest "$url/" -UseBasicParsing
Invoke-WebRequest "$url/admin/" -UseBasicParsing
Invoke-WebRequest "$url/api/bootstrap" -UseBasicParsing
```

Expected: both SPAs return HTML and assets return their actual content types; `/api/bootstrap` returns a JSON application response rather than SPA HTML. A Firestore-backed call proves OIDC exchange. A source **Sync now** must return a run ID and Workflow observability must show flow/step execution.

### Workflow release gate

Exact pins are `workflow@4.8.5` and `@workflow/builders@4.1.10`, the latest stable versions checked on 2026-08-26. `npm audit` reports transitive advisories in the Workflow build/runtime tree; no newer stable release exists and npm's suggested downgrade is incompatible. The package is needed at runtime for Workflows, so production-omit audit does not eliminate it. Before production cutover, upgrade to a fixed stable release and rerun manifest/queue/deployment tests, or formally accept the bounded release risk after reviewing each advisory. Do not switch to the 5.0 prerelease solely to silence audit.

## Scheduling

Hobby permits daily cron, so `vercel.json` runs reconciliation at `02:00 UTC`. Initial crawls and **Sync now** start Workflows immediately and do not depend on cron. To meet the approved 15-minute cadence, upgrade to Pro or use an external authenticated scheduler with `Authorization: Bearer $CRON_SECRET`.

## Migration and rollback

1. Run `node scripts/migrate-vercel-blob.mjs` and review the redacted counts.
2. Run with `--apply` only after the destination and encryption key version are verified.
3. Reconnect every `reauth-required` source and re-enable roots deliberately.
4. Complete a full initial crawl and reconciliation in staging.
5. Enroll a fresh TV; legacy browser sessions are not migrated.
6. Keep the previous deployment available until one full reconciliation completes.

Rollback the Vercel alias to the previous deployment. Do not delete new Firestore data during an application rollback. Export/backup metadata before destructive schema work; restore into staging first and verify devices, roots, sources, nodes, and watch history before production use.

## Observability

Monitor safe error codes, request/source/device/run IDs, repeated OAuth refresh failures, sync backlog, media URL-vending failures, Firestore quota, and Vercel function errors. Never log passphrases, cookies, OAuth codes/tokens, provider URLs, encrypted payload material, or full provider responses.
