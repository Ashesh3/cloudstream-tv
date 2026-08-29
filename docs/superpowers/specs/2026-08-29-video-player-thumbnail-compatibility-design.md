# Video Player and Thumbnail Compatibility Design

## Goal

Restore the more compatible July playback experience inside Cloudframe's current unified viewer, and make folder browsing feel immediate by vending, warming, and renewing thumbnails before the user scrolls to them.

## Confirmed current failures

- The TV requests thumbnail URLs only for rows mounted by the virtual grid. Items below the overscan window do not begin URL vending or image download until scrolling mounts them.
- Folder items are excluded twice: the TV client rejects folder previews, and the direct-media service always returns `unavailable` for folder handles.
- OneDrive folder listing already expands thumbnail metadata, but normalization reduces it to `hasPreview`; later thumbnail vending performs another Microsoft Graph request.
- The current viewer renders a native `<video>` with Cloudframe controls. The July 2026 player used Video.js and had a more mature playback lifecycle.
- Video.js v10 is currently beta and officially targets evergreen browsers, not smart TVs. Cloudframe must preserve its Chromium 68 native-video fallback.

## Playback architecture

- Pin `@videojs/html` to `10.0.0-beta.32`. Use the HTML/custom-element package because the TV application is Preact; do not add React and React DOM solely for the player.
- Register the Video.js v10 video player and render its state boundary around the existing native `HTMLVideoElement`. The media element remains the source of truth for Cloudframe's watch history, buffering, seeking, resume, refresh, and error callbacks.
- Keep Cloudframe's existing full-screen viewer shell, remote-key routing, image viewer, slideshow, URL renewal, and authorization behavior.
- Use Video.js as progressive enhancement. If the v10 registration or custom-element runtime is unavailable, the same native `<video>` remains rendered and playable with Cloudframe controls. Playback must never depend on successful Video.js initialization on Chromium 68.
- Preserve original provider media URLs and MIME types. Video.js may improve player lifecycle and source selection, but Cloudframe still does not transcode and cannot add codecs absent from the TV.
- Keep the current provider-specific media boundary: OneDrive remains direct and Google Drive remains the authorized same-origin range proxy.

## Thumbnail data contract

- Extend provider nodes with an optional temporary preview capability containing a bounded URL and expiry. Google Drive derives it from `thumbnailLink`; OneDrive derives it from the thumbnail set already returned by `$expand=thumbnails`.
- Seal that capability inside the existing device/source/root-bound browse handle. Do not add raw provider preview URLs to folder or home JSON.
- Direct thumbnail vending first validates and returns an unexpired sealed preview capability. It calls the provider thumbnail endpoint only when the listing had no preview, the capability expired, or the image needs one fresh URL after a decode failure.
- The client requests every loaded item's thumbnail handle immediately when a folder page arrives. Because initial provider previews are already sealed in those handles, the vending response avoids one provider round trip per item.
- Validate every preview URL with the provider-specific URL policy before it enters a thumbnail-vending response. A malformed sealed preview becomes `unavailable` for that item.
- Provider IDs, access tokens, refresh tokens, provider response bodies, and raw preview capabilities remain absent from browse JSON.

## Folder previews

- Allow authorized folder handles through direct thumbnail vending instead of unconditionally returning `unavailable`.
- Allow `hasPreview: true` for folder DTOs and render a thumbnail in `FolderCard` when present.
- OneDrive representative folder thumbnails use Graph's folder thumbnail support. Google Drive folders without a provider thumbnail retain Cloudframe's existing program-stock fallback.
- A missing provider preview is a normal `unavailable` result, not a folder-browse failure.

## OneDrive repair

- Reuse the thumbnail URL already returned by OneDrive folder listing by sealing it into the browse handle instead of issuing a second Graph request for the initial page.
- Retain the direct thumbnail endpoint for renewal and for pages where Graph omits expanded thumbnail data.
- Update the OneDrive URL policy to accept capability-bearing subdomains of `storage.live.com` as well as the already allowed `files.1drv.com`, SharePoint download handler, and Microsoft content hosts. Continue rejecting Graph API URLs, credentials, fragments, non-HTTPS URLs, empty capabilities, traversal-shaped paths, and unrelated Microsoft hosts.
- Add realistic OneDrive folder, image, and video thumbnail fixtures covering both `files.1drv.com` and subdomain `storage.live.com` URLs.

## Browser prefetch and cache warming

- Request missing thumbnail URLs for every item in the currently loaded provider page immediately, not only mounted virtual-grid rows.
- Split thumbnail requests into bounded chunks so encrypted handles remain below the 32 KiB JSON body limit and the 100-item endpoint limit.
- Warm each ready URL with an off-DOM `Image` object as soon as it enters state. Deduplicate by URL, retain the object until load/error, and set `referrerPolicy = "no-referrer"` before assigning `src`.
- Keep virtual rendering for DOM and memory efficiency; prefetch changes network readiness, not the number of mounted cards.
- Start fetching the next provider page when focus or scroll enters the final two visible rows of loaded content. Also schedule a low-priority next-page fetch after the current page's thumbnail work is queued, so remote navigation does not need to hit the end before pagination starts.
- Maintain a single in-flight page request and existing cursor-cycle/no-progress protections. A failed speculative page request leaves current items usable and exposes the existing retry state without moving focus.
- On back navigation, preserve already loaded items, preview state, scroll position, and cache-warmed URLs for that stack entry.

## Failure and expiry behavior

- A failed thumbnail image marks only that item stale and schedules one fresh URL vend. It must not poison the URL for other items or loop indefinitely.
- Expiry timers apply to listing-derived and separately vended previews equally. URLs are removed shortly before or at expiry and renewed while their item remains in the loaded folder page.
- Provider authentication, device revocation, root removal, and expired navigation retain their existing fail-closed behavior.
- Individual unavailable thumbnails remain stock fallbacks; one provider thumbnail failure must not reject the batch or erase the folder.

## Verification

- Provider contract tests prove OneDrive listing previews survive normalization, folder previews are represented, and unsupported/authenticated Graph URLs are rejected.
- Browse-handle, live-browse, and API decoder tests prove preview capabilities remain sealed, folder `hasPreview` is accepted, and provider identity or credentials are not exposed.
- Direct-media tests prove folder handles are vendable and realistic OneDrive thumbnail hosts pass while attacker-shaped hosts remain blocked.
- TV tests prove first-page thumbnails are requested before scrolling, requests are chunked, ready URLs are browser-warmed, folder cards render previews, failed URLs refresh once, and next-page loading begins before end-of-grid focus.
- Viewer tests prove the native video element and all current callbacks remain intact under the Video.js v10 wrapper and still work when custom elements are unavailable.
- Run focused tests red then green, full tests, typecheck, lint, production build, Vercel build, and the pinned Chromium 68 runtime check.
- Browser verification uses the synthetic TV journey to confirm thumbnails are already loaded while scrolling and that image/video/folder cards preserve remote focus.
- Live LG webOS acceptance is required before deployment because Video.js v10 does not officially support smart TVs.
