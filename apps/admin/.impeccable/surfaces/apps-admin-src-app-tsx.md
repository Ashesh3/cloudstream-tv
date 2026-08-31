---
version: 1
slug: "apps-admin-src-app-tsx"
primary_target: "apps/admin/src/app.tsx"
related_targets: ["apps/admin/src/components/source-workbench.tsx","apps/admin/src/components/sources.tsx","apps/tv/src/app.tsx"]
---

# Cloudframe Night Admin and TV

## Scope and mode

- Mode: Operate.
- One coherent Astryx design system across the household administrator and remote-first TV.
- The shipped world is Cloudframe Night: quiet graphite surfaces, warm-white content, and cloud-blue focus/action.

## Product truth

- Cloudframe is a private, self-hosted, single-household cloud-media browser.
- Google Drive and OneDrive folders are browsed live; there is no crawl, indexing, quota, or recovery-mirror workflow.
- Only selected roots are exposed to approved televisions.
- Encrypted SQLite and the transcode cache live under `/data`; operators protect them with explicit backups.
- Compatible media uses browser-side authenticated direct delivery. Incompatible video may use one active FFmpeg demand-paged HLS transcode.
- The configured TV target is webOS TV 24 / Chromium 108.

## Administrator

- AppShell, SideNav/MobileNav, and one Layout own the frame.
- Requests, devices, sources, provider folders, and selected household folders use dense rows.
- Settings is an ordered Astryx form and truth surface.
- Committed changes update locally, close task UI, then refresh once; refresh failures show recovery warnings without rollback.

## Television

- State screens are remote-scale and keep enrollment, offline, unsupported, no-roots, source-error, and empty-folder states distinct.
- Collection and media cards keep one native button as the remote focus authority.
- The source drawer preserves explicit directional focus, Back dismissal, and exact restoration.
- The viewer preserves the product reducer, direct-media bridge, HLS lifecycle, Video.js fallback, and capture-phase remote keys.

## Success

- An administrator can connect a source, choose a folder, approve a television, and understand current household/storage/transcoder truth without infrastructure jargon.
- A family member can identify focus at TV distance, browse collections, open media, and recover from explicit failures with a directional remote.
- Admin and TV feel like one private household product.
