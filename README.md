# CloudStream TV

A Next.js web app for smart TVs that connects to Google Drive and OneDrive, displays videos in a Netflix-style dark cinematic UI optimized for TV remote control navigation, and streams video directly from cloud CDNs with zero-buffer playback.

<img width="1326" height="707" alt="image" src="https://github.com/user-attachments/assets/7bd4c378-eca9-4885-a145-43eb54cb6bfe" />
<img width="1157" height="673" alt="image" src="https://github.com/user-attachments/assets/0e9fe562-6fef-41cd-b48c-1015ad043899" />
<img width="595" height="487" alt="image" src="https://github.com/user-attachments/assets/beca2bf5-a220-4b00-9048-1c299cf4dea1" />
<img width="1166" height="667" alt="image" src="https://github.com/user-attachments/assets/4b141d49-d6a2-45d5-bae9-d783af70d897" />



## Features

- **Cloud storage connections** -- Browse and play videos from Google Drive and OneDrive
- **TV-optimized UI** -- Dark cinematic interface designed for large screens
- **D-pad navigation** -- Full keyboard and remote control support with spatial focus management
- **Direct CDN streaming** -- Videos stream straight from Google/Microsoft CDNs for zero-buffer playback
- **Phone-based setup via QR code** -- Scan a code on your TV to complete setup from your phone
- **Watch history and resume** -- Pick up where you left off across sessions
- **Access code protection** -- Optional site-wide access code to restrict usage

## Tech Stack

- [Next.js 16](https://nextjs.org/) with React 19
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Framer Motion](https://www.framer.com/motion/) for animations
- [Video.js](https://videojs.com/) for video playback
- [Vercel KV](https://vercel.com/docs/storage/vercel-kv) for token and session storage

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- A Vercel account (for KV storage)

### Clone and Install

```bash
git clone <your-repo-url>
cd tv-video-ui
npm install
```

### Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env.local
```

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (server-side) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth client ID (client-side, used for OAuth redirects on the setup page) |
| `ONEDRIVE_CLIENT_ID` | Microsoft/OneDrive OAuth client ID (server-side) |
| `ONEDRIVE_CLIENT_SECRET` | Microsoft/OneDrive OAuth client secret |
| `NEXT_PUBLIC_ONEDRIVE_CLIENT_ID` | OneDrive OAuth client ID (client-side, used for OAuth redirects on the setup page) |
| `KV_REST_API_URL` | Vercel KV REST API endpoint |
| `KV_REST_API_TOKEN` | Vercel KV REST API token |
| `NEXT_PUBLIC_APP_URL` | Public app URL (default: `http://localhost:3000`) |
| `ACCESS_CODE` | Optional site-wide access code; leave empty to disable |

### Google Cloud Console Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Navigate to **APIs & Services > Credentials** and create an OAuth 2.0 Client ID.
4. Set the authorized redirect URI to `<your-app-url>/api/auth/google/callback`.
5. Enable the **Google Drive API** under **APIs & Services > Library**.
6. Under **OAuth consent screen**, add the `drive.readonly` scope.
7. Copy the client ID and client secret into your `.env.local`.

### Microsoft Azure Setup

1. Go to the [Azure Portal](https://portal.azure.com/) and navigate to **App registrations**.
2. Register a new application.
3. Under **Authentication**, add a redirect URI: `<your-app-url>/api/auth/onedrive/callback`.
4. Under **API permissions**, add **Microsoft Graph > Files.Read.All** (delegated).
5. Under **Certificates & secrets**, create a new client secret.
6. Copy the Application (client) ID and client secret into your `.env.local`.

### Vercel KV Setup

1. In your [Vercel dashboard](https://vercel.com/dashboard), go to **Storage** and create a new KV database.
2. Copy the `KV_REST_API_URL` and `KV_REST_API_TOKEN` into your `.env.local`.

### Run Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment

Deploy to Vercel:

```bash
vercel deploy
```

Set all environment variables in the Vercel dashboard under your project's **Settings > Environment Variables**. Make sure `NEXT_PUBLIC_APP_URL` points to your production URL and that your OAuth redirect URIs match.

## Usage

1. Set an `ACCESS_CODE` in your environment variables if you want to restrict access.
2. Open the app on your TV browser.
3. Scan the QR code displayed on the TV with your phone.
4. On your phone, connect your Google Drive and/or OneDrive accounts through the setup flow.
5. Browse your video library on the TV using the remote control.
6. Select a video to start streaming. Playback resumes from where you left off.

## Architecture

CloudStream TV separates concerns between server and client to keep credentials secure and playback fast:

1. **Server-side listing** -- The Next.js backend uses stored OAuth tokens to fetch folder and file listings from Google Drive and OneDrive APIs. Tokens are stored in Vercel KV and never sent to the client.
2. **Client-side streaming** -- When a user selects a video, the server returns a short-lived CDN URL. The client streams video directly from Google or Microsoft CDNs, bypassing the application server entirely.
3. **Token isolation** -- OAuth tokens and secrets remain on the server. The client only receives opaque session identifiers and temporary playback URLs.

## License

[MIT](LICENSE)
