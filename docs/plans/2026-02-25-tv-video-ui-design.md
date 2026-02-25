# TV Video UI — Design Document

**Date:** 2026-02-25
**Status:** Approved

## Overview

A Next.js web app for large smart TVs that connects to Google Drive and OneDrive, displays video files in a TV-optimized browsing UI, and streams them directly from cloud storage with zero-buffer playback. Setup is done from a phone/computer; the TV only displays content and plays video.

## Decisions

| Decision | Choice |
|---|---|
| User model | Single-user / household |
| Hosting | Vercel |
| Video streaming | Direct streaming via signed URLs from cloud CDNs |
| Video player | Video.js with custom TV skin |
| Navigation | Custom D-pad spatial navigation |
| Token storage | Server-side with Vercel KV |
| UI style | Dark cinematic (Apple TV / Plex aesthetic) |
| Thumbnails | Cloud provider thumbnail APIs |
| Setup flow | Phone/computer setup via QR code pairing |
| V1 features | Browse, play, watch history / resume playback |
| Architecture | Next.js 14+ App Router |

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14+ (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Animations | Framer Motion |
| Video Player | Video.js with custom TV skin |
| State Management | React Context (minimal client state) |
| Database | Vercel KV |
| Hosting | Vercel |
| Cloud APIs | Google Drive API v3, Microsoft Graph API |

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    TV Browser (Client)                   │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Browse UI   │  │ Video Player │  │  D-pad Nav    │  │
│  │  (Client)    │  │  (Video.js)  │  │  System       │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────────┘  │
│         │                 │                              │
│         │ fetch listings  │ stream video                 │
└─────────┼─────────────────┼──────────────────────────────┘
          │                 │
          ▼                 │
┌─────────────────────┐     │
│  Next.js Server     │     │
│  (Vercel)           │     │
│                     │     │
│  /api/auth/callback │     │
│  /api/stream-url    │──── │ ──► Returns signed URL
│  /browse/[path]     │     │
│  (Server Component) │     │
│         │           │     │
│    ┌────▼────┐      │     │
│    │Vercel KV│      │     │
│    │(tokens) │      │     │
│    └─────────┘      │     │
└─────────────────────┘     │
                            │
          ┌─────────────────▼──────────────────┐
          │    Google Drive / OneDrive CDN      │
          │    (Direct streaming to browser)    │
          └────────────────────────────────────┘
```

**Data Flow:**
1. **Setup (once, from phone):** User visits `/setup`, authenticates with Google/OneDrive, OAuth tokens stored in Vercel KV
2. **TV browsing:** Server Components fetch folder listings using stored tokens, render HTML with thumbnails
3. **Video playback:** Client requests a signed URL from `/api/stream-url`, Video.js streams directly from the cloud provider
4. **Token refresh:** Server-side middleware auto-refreshes expired OAuth tokens before API calls

**Key principle:** The TV browser never sees OAuth tokens. It only receives temporary signed URLs for video playback and pre-rendered folder listings.

## Page Structure & Routes

```
/                       → Home: Grid of all videos from connected sources
/folder/[...path]       → Folder view: Contents of a specific folder
/play/[videoId]         → Full-screen video player
/setup                  → Setup page (designed for phone/computer, not TV)
/setup/callback/google  → OAuth callback for Google Drive
/setup/callback/onedrive → OAuth callback for OneDrive
/api/stream-url         → Generates signed streaming URLs
/api/refresh-token      → Internal: refreshes expired OAuth tokens
```

### Home Page (`/`)

- Shows all connected sources as horizontal scrolling rows (Netflix-style)
- Each row = one connected cloud source (e.g., "My Google Drive", "Family OneDrive")
- Within each row, videos displayed as large landscape thumbnail cards
- Folders displayed as folder cards at the start of each row
- Focus starts on the first video/folder in the first row

### Folder View (`/folder/[...path]`)

- Grid layout of videos and sub-folders
- Breadcrumb navigation at the top (navigable with remote)
- Same card style as home page

### Player Page (`/play/[videoId]`)

- Full-screen Video.js player
- Custom oversized controls: play/pause, seek bar, volume, back button
- Press Back/Escape to return to browse view
- Auto-saves playback position to Vercel KV every 30 seconds
- On load, resumes from saved position if available

### Setup Page (`/setup`)

- Not TV-optimized (phone/computer only)
- Shows connected sources with status
- "Add Google Drive" / "Add OneDrive" buttons trigger OAuth flows
- Folder picker to select which folder(s) to expose on the TV
- Displays a pairing code or QR code that links the TV to this setup

## TV UI Components

### Card Component (Video/Folder)

- Size: ~300px × 170px (16:9 landscape) at 1080p, scales with viewport
- Thumbnail fills the entire card
- Title overlaid at bottom with gradient fade background
- Watch progress bar at bottom (thin, colored line) if partially watched
- Folder cards use a distinct folder icon overlay
- On focus: card scales up ~110%, subtle glow/border, title becomes fully visible
- Smooth CSS transition (200ms ease-out)

### Grid Layout

- Horizontal scrolling rows on home page (Netflix-style)
- Vertical grid on folder pages (4-5 columns at 1080p)
- Oversized spacing between cards for readability on large screens
- Scroll snaps to card boundaries

### D-Pad Navigation System

- Custom focus manager tracks a 2D grid of focusable elements
- Arrow keys move focus spatially (up/down/left/right)
- Focus wraps at row boundaries (optional)
- Enter/OK selects the focused item
- Escape/Back navigates up (player → browse, subfolder → parent)
- Visual focus indicator: bright border + scale + slight shadow
- Focus is never lost — if current element is removed, focus moves to nearest neighbor
- Long-press left/right on seek bar jumps 10s/30s

### Video Player Controls (Video.js custom skin)

- Controls appear on any key press, auto-hide after 5 seconds
- Play/Pause: center of screen, large icon (100px+)
- Seek bar: bottom of screen, thick (20px height), easy to navigate with left/right
- Current time / Duration: large text beside seek bar
- Back button: top-left corner
- Volume: right side vertical bar (optional, TV usually handles volume)
- All controls navigable with D-pad
- Left/Right arrow while controls visible: seek ±10s
- Play/pause toggles with Enter or spacebar

### Animations (Framer Motion)

- Page transitions: fade + slight slide
- Card focus: scale + glow (CSS transforms, GPU-accelerated)
- Folder open: cards fly in from the right
- Player enter: fade to black, then video
- Keep animations under 300ms for responsiveness
- Respect `prefers-reduced-motion`

## Streaming & Zero-Buffer Strategy

### Direct Streaming Architecture

1. Client requests `/api/stream-url?fileId=xxx&provider=google`
2. Server validates request, fetches a fresh download URL from the cloud provider API
3. Server returns the signed/temporary URL to the client
4. Video.js loads the URL directly — browser streams from Google/OneDrive CDN

### Zero-Buffer Techniques

| Technique | How |
|---|---|
| Direct CDN streaming | Browser streams from Google/OneDrive's CDN, not through our server. Their CDNs are globally distributed and fast. |
| Range request support | Both Google Drive and OneDrive support HTTP Range requests natively. Video.js handles partial content (206 responses) automatically. Enables instant seek without re-downloading. |
| Preload metadata | Set `preload="metadata"` on the video element. Browser fetches just the file headers (duration, codec info) immediately. |
| Buffer ahead aggressively | Configure Video.js to buffer 60-120 seconds ahead. On a TV with stable WiFi/Ethernet, this prevents stuttering. |
| URL pre-generation | When browsing a folder, pre-generate signed URLs for visible videos in background. Playback starts instantly — no API round-trip delay. |
| Codec awareness | MP4 (H.264/AAC) plays natively in all TV browsers. Non-MP4 files (MKV, AVI) show a warning icon — transcoding is out of scope for V1. |
| Connection quality detection | Monitor `navigator.connection` API (where available) and adjust buffer targets. |

### Seek Optimization

- Range requests mean seeking doesn't restart the download
- Browser fetches only the bytes needed for the new position
- Video.js's built-in buffering handles this transparently
- Seek bar shows buffered ranges visually

### Limitations

- MKV files won't play in most TV browsers (no native codec support)
- Very large files (10GB+) may have initial load delays depending on CDN
- Cloud provider rate limits could affect rapid browsing of many files

## Cloud Storage Integration

### Google Drive

- OAuth 2.0 with `drive.readonly` scope
- List files: `GET /drive/v3/files?q='folderId' in parents and mimeType contains 'video/'`
- Thumbnails: `file.thumbnailLink` from API response
- Streaming URL: `webContentLink` for files or generate via API
- Token refresh: `refresh_token` grant type, new access token stored in Vercel KV

### OneDrive

- OAuth 2.0 with `Files.Read` scope via Microsoft Graph API
- List files: `GET /me/drive/items/{folderId}/children?$filter=startswith(file/mimeType,'video')`
- Thumbnails: `GET /me/drive/items/{itemId}/thumbnails`
- Streaming URL: `@microsoft.graph.downloadUrl` field — pre-authenticated CDN URL valid for a few hours
- Token refresh: same refresh_token flow, stored in Vercel KV

## Data Model (Vercel KV)

```
Key: "connections:{sessionId}"
Value: [{
  id: "conn_xxx",
  provider: "google" | "onedrive",
  accessToken: "...",
  refreshToken: "...",
  tokenExpiry: 1234567890,
  folders: [{ id: "folder_id", name: "Movies" }]
}]

Key: "watch-history:{sessionId}:{fileId}"
Value: {
  position: 1234,       // seconds
  duration: 7200,       // total duration
  lastWatched: "2026-02-25T..."
}

Key: "pairing:{code}"
Value: {
  sessionId: "uuid",
  createdAt: 1234567890,
  expiresAt: 1234567890
}
```

## Setup & Pairing Flow

1. User opens the app on TV browser → TV shows a 6-digit pairing code (e.g., `TV-482913`) and a QR code pointing to `https://app.example.com/setup?code=TV-482913`
2. User scans QR code with phone or types the URL
3. Phone setup page shows "Connect a cloud source" with Google Drive / OneDrive buttons
4. User clicks a provider → standard OAuth flow on phone → callback stores tokens in Vercel KV keyed by the pairing code
5. Phone shows a folder picker → user selects folders → folder IDs stored in Vercel KV
6. TV polls `/api/status?code=TV-482913` every 3 seconds. When tokens are stored, TV transitions to browse UI
7. Pairing code is replaced with a persistent session ID stored in TV's localStorage

### Security

- Pairing codes expire after 10 minutes
- Once paired, TV uses a long-lived session ID (UUID) in localStorage
- All API calls from TV include this session ID
- OAuth tokens never leave the server
- Setup page accessible again to add/remove connections using the session ID
