# Firebase and Vercel operations

## Architecture and safety contract

- The encrypted private Vercel Blob snapshot is authoritative active control state.
- Vercel Runtime Cache is a five-minute hot copy; each protected request conditionally revalidates the cached Blob ETag.
- Firestore stores one write-only recovery document at `controlPlaneBackups/{householdId}`. Ordinary TV, admin, and provider traffic performs zero steady-state Firestore reads.
- Google Drive and OneDrive metadata is listed live through Vercel. Direct provider media bypasses Vercel.
- Migration and explicit recovery are operator-only and dry-run-first. Restore reads exactly one recovery document.
- No legacy Firestore document or Google Cloud/Firebase project is deleted by these procedures. Future cleanup requires separate approval, an exact inventory, and a dry run.

Keep preview and production isolated with distinct `HOUSEHOLD_ID`, `CONTROL_PLANE_ENV`, Blob pathname, Runtime Cache key, key material, and recovery document.

## Current development resources

| Resource | Value |
|---|---|
| GCP/Firebase project | `cloudframe-tv-dev` (`7371742203`) |
| Firestore | Native `(default)`, `asia-south1` |
| Vercel team/project | `ashsec` / `tv-video-ui` |
| Vercel project ID | `prj_CFOxdTl9iBsESvS1sjnyWkh7MxEr` |
| Vercel function region | `bom1` |
| WIF pool/provider | `vercel` / `vercel-ashsec` |

These values describe the last verified development setup and may drift. Re-check them before deployment. Do not unlink unrelated billing projects or delete any project while configuring this control plane.

## Firebase configuration

Only Firestore is used; Firebase Authentication, Storage, Hosting, and Functions are intentionally absent. Browser rules deny every direct read and write, and the final composite-index set is empty.

```powershell
firebase use dev
firebase deploy --only firestore:rules,firestore:indexes
gcloud firestore databases describe --database='(default)' --project=cloudframe-tv-dev
firebase firestore:indexes --project cloudframe-tv-dev
```

For disposable local verification:

```powershell
firebase emulators:exec --only firestore "npm test"
```

Do not aim general tests at a live database.

## Create and bind private Vercel Blob

1. Create a Blob store in the Vercel project and keep its access private.
2. Bind the store to the intended Vercel environments.
3. Copy only the store identifier into `BLOB_STORE_ID`; do not print or commit any store token.
4. Set `CONTROL_PLANE_ENV=preview` for non-production and `CONTROL_PLANE_ENV=production` for production.
5. Verify that the candidate writes `cloudframe/control-plane/{environment}/{householdId}.json.enc` with private access.

The application uses server-side Blob access and stores an AES-256-GCM envelope. Runtime Cache uses the same encrypted envelope with a 300-second TTL and the tag `cloudframe-control:{environment}:{householdId}`.

## Workload Identity Federation and exact identities

Use Vercel OIDC to Google WIF; do not create a user-managed JSON key for either runtime identity.

```text
issuer:   https://oidc.vercel.com/ashsec
audience: https://vercel.com/ashsec
provider: projects/7371742203/locations/global/workloadIdentityPools/vercel/providers/vercel-ashsec
```

Bind the expected Vercel preview/production subjects only. Configure two separate principals:

1. **Permanent runtime writer (`GCP_SERVICE_ACCOUNT_EMAIL`)**: custom role with exactly `datastore.entities.create` and `datastore.entities.update`; no get/list permission. Add an IAM Condition for the exact `controlPlaneBackups/{householdId}` document resource where supported. This client is passed only to the recovery mirror.
2. **Operator (`GCP_OPERATOR_SERVICE_ACCOUNT_EMAIL`)**: migration/recovery identity kept outside the deployed runtime. Export its external-account credential configuration to a local protected file referenced by `GCP_OPERATOR_CREDENTIALS_FILE`. The scripts reject credentials that impersonate the runtime writer.

The permanent writer should fail a direct `get`/list probe. Verify its write path with a controlled application mutation and the `control_plane_mirror_write` event; do not run an out-of-band probe that could overwrite the recovery document. Do not claim least privilege from browser rules alone; server IAM bypasses those rules.

## Environment inventory

Use `.env.example` as the canonical name list. Do not print values. Important constraints:

- `APP_ORIGIN` is one exact HTTPS origin with no path, query, fragment, or credentials.
- `CONTROL_PLANE_ENV` is exactly `preview` or `production`.
- `FIRESTORE_EMULATOR_HOST` is local only.
- `GCP_OPERATOR_SERVICE_ACCOUNT_EMAIL` and `GCP_OPERATOR_CREDENTIALS_FILE` belong on the operator workstation/CI job, not in the Vercel runtime.
- `CONTROL_PLANE_KEY_VERSION`, `SESSION_KEY_VERSION`, `BROWSE_HANDLE_KEY_VERSION`, and `PROVIDER_TOKEN_KEY_VERSION` use canonical lowercase `v1`; matching environment suffixes are uppercase `*_V1`.
- `ROOT_ID_SECRET`, `BROWSE_ID_SECRET`, `RATE_LIMIT_SECRET`, `CSRF_SECRET`, and `ADMIN_PASSPHRASE_PEPPER` are independent server-only secrets.

### Generate initial secret material

Generate each value independently. Versioned AES keys are 32 random bytes encoded as canonical base64url; HMAC/pepper secrets must contain at least 32 UTF-8 bytes.

```powershell
node -e "for (const n of ['CONTROL_PLANE_KEY_V1','SESSION_KEY_V1','BROWSE_HANDLE_KEY_V1','PROVIDER_TOKEN_KEY_V1']) console.log(n+'='+require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "for (const n of ['ADMIN_PASSPHRASE_PEPPER','CSRF_SECRET','BROWSE_ID_SECRET','ROOT_ID_SECRET','RATE_LIMIT_SECRET']) console.log(n+'='+require('node:crypto').randomBytes(32).toString('base64url'))"
```

Move generated values directly into an approved secret manager/Vercel environment. Do not save terminal output in git, tickets, or reports.

### Rotate versioned keys

For one key family at a time:

1. Generate a new 32-byte key as `*_V2`.
2. Deploy with both `*_V1` and `*_V2` present while the `*_VERSION` selector still equals `v1`.
3. Change the selector to lowercase `v2` and deploy.
4. Exercise the relevant sessions/control/provider path and perform a real control mutation so new durable material uses `v2`.
5. Keep `*_V1` until all still-valid encrypted values or cookies using it are expired, migrated, or deliberately invalidated; then remove it in a separate deployment.

Rotate `ROOT_ID_SECRET` only with an explicit root-ID migration plan because derived root IDs change. Rotating `BROWSE_ID_SECRET` invalidates local history matching; rotating `RATE_LIMIT_SECRET` resets ephemeral buckets; rotating `CSRF_SECRET`/session keys invalidates active sessions. Record these consequences before changing them.

## OAuth redirects and direct media

Configure provider redirects to the exact `APP_ORIGIN`:

```text
https://<host>/api/admin/sources/google/callback
https://<host>/api/admin/sources/onedrive/callback
```

Google uses Drive read-only offline access. Microsoft uses `Files.Read`, `offline_access`, and identity scopes. The callback host is derived server-side; the browser cannot supply an arbitrary redirect.

Folder/media metadata is listed live through Vercel with no-store responses. Media URLs are vended only after current authorization. Google direct playback includes a short-lived access token in the query string; OneDrive returns its temporary download URL. Never log either URL. Range traffic and bytes must go from provider to TV, not through Vercel.

## Build and preview deployment

Vercel Framework Preset is **Other**:

```text
Build command: npm run build:vercel
Output directory: .vercel/output
Install command: npm install
Node: 24.x
```

```powershell
vercel pull --yes --environment=preview
npm run build:vercel
vercel deploy --prebuilt --target=preview
```

`npm run build:vercel` forces a clean production rebuild and packages exactly one API function. Never deploy output from `npm run build:e2e`.

Use an authenticated browser session for preview/production smoke tests if direct PowerShell receives a Vercel Security Checkpoint. Verify both SPAs, static asset content types, API JSON, admin login, TV enrollment, live folder browsing, and direct provider playback.

## Migration: dry run, apply, and verification

The migration reads only legacy household, pending request, device, source, and root records needed for the compact document. It does not read provider-file, watch-history, rate-limit, or workflow collections.

Set the operator-only environment without displaying values, then run:

```powershell
node --experimental-strip-types scripts/migrate-vercel-control-plane.ts
node --experimental-strip-types scripts/migrate-vercel-control-plane.ts --apply
```

The first command is a dry run. Review only the redacted `householdId`, `revision`, entity counts, and checksum. Before `--apply`, verify the target environment, Blob store, household, control keyring, provider-token keyring, and operator identity. Apply creates or safely compares the encrypted Blob, verifies its ETag/checksum, writes the single recovery copy, and reads it back with the operator credential for verification. It refuses unsafe overwrites.

Do not move the production alias until apply has verified both copies. Preview must use fully separate state and secrets.

## Explicit recovery: dry run and apply

Use this only when the authoritative Blob is missing or corrupt and public requests are failing closed.

```powershell
node --experimental-strip-types scripts/restore-vercel-control-plane.ts
node --experimental-strip-types scripts/restore-vercel-control-plane.ts --apply
```

The dry run reads exactly one recovery document, `controlPlaneBackups/{householdId}`, validates schema and encrypted provider-token metadata, and prints only redacted counts, revision, and checksum. Apply writes and verifies the private Blob and refreshes Runtime Cache. It refuses to replace a valid active document with mismatched or older state.

Perform a recovery drill in an isolated staging environment with separate state. Verify admin access, device assignments/revocations, sources, roots, and direct playback. Recovery does not restore local TV watch history because that history exists only in the TV browser.

## Mirror-delay behavior and observability

A successful private Blob commit is not rolled back if the asynchronous recovery write fails. The API:

- exposes **Recovery copy delayed** from Runtime Cache status;
- defers the same idempotent full-document write through `waitUntil()`; that task makes at most three total write attempts;
- rewrites the entire latest document on the next successful control mutation;
- never reads Firestore to repair the mirror.

Monitor these secret-safe structured events/counters:

| Event | Meaning | Safe fields |
|---|---|---|
| `control_plane_blob_read` | Authoritative Blob was read/revalidated | request ID, household ID, `count` |
| `control_plane_cache_hit` | Runtime Cache contained a usable envelope | request ID, household ID, `count` |
| `control_plane_cache_miss` | Runtime Cache did not contain a usable envelope | request ID, household ID, `count` |
| `control_plane_mirror_write` | Recovery document write succeeded | request ID, household ID, revision, `count` |
| `control_plane_mirror_failed` | Recovery write attempts ended delayed | request ID, household ID, revision, normalized error code, `count` |
| `control_plane_restore_read` | Operator restore read the recovery document | request ID, household ID, `count` |

Never log passphrases, cookies, OAuth codes, access/refresh tokens, provider URLs, provider response bodies, encrypted document bodies, hashes, or raw credentials.

## Prove zero Firestore reads

Run an authenticated observation window after migration is complete:

1. Record the exact UTC start time and current Firestore read metric/counter.
2. Continuously reload admin state, browse nested Google/OneDrive folders, request thumbnails, play and seek media, renew one expired media URL, and exercise local resume history.
3. Make no control mutations during the measurement window; mutations should produce one recovery write, not a read.
4. Confirm Vercel events show Blob/cache/provider activity and no recovery-read event.
5. Confirm Cloud Monitoring reports a zero delta for Firestore document reads for the exact project/database and time window. Account for metric ingestion delay before concluding.
6. Save only timestamps, aggregate counters, commit/deployment IDs, and pass/fail evidence. Do not save URLs, document bodies, provider IDs, or credentials.

Expected result: zero steady-state Firestore reads. Operator migration/recovery invalidates the observation window and must be measured separately.

## Rollback and retention

Rollback the Vercel alias to the previous deployment if the new control plane fails. Keep the new private Blob and recovery document intact while investigating; do not delete or rewrite legacy collections during application rollback.

The deployment intentionally leaves legacy `nodes`, `watchHistory`, `rateLimits`, `adminSessions`, `deviceSessions`, `oauthStates`, source workflow fields, and workflow infrastructure data untouched. No operation here deletes a Google Cloud/Firebase project. Any future cleanup is a new destructive operation requiring explicit approval, an exact inventory, a dry run, and its own rollback plan.
