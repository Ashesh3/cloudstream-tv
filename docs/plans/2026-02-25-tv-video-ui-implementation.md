# TV Video UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Next.js TV-optimized video streaming app that connects to Google Drive/OneDrive and streams video directly from cloud CDNs with zero-buffer playback.

**Architecture:** Next.js 14+ App Router with Server Components for data fetching, Client Components for interactive TV UI. OAuth tokens stored server-side in Vercel KV. Video streams directly from cloud provider CDNs via signed URLs. Phone-based setup with QR code pairing.

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, Framer Motion, Video.js, Vercel KV, Google Drive API v3, Microsoft Graph API

**Design doc:** `docs/plans/2026-02-25-tv-video-ui-design.md`

---

## Phase Overview & Dependencies

```
Phase 1: Project Foundation (sequential — everything depends on this)
    │
    ├── Phase 2A: D-pad Navigation System ──────────┐
    ├── Phase 2B: Vercel KV & Session Management     ├── Phase 3: UI Components
    ├── Phase 2C: Google Drive API Client            │
    └── Phase 2D: OneDrive API Client                │
         │                                           │
         ├── Phase 4A: API Routes ◄──────────────────┤
         ├── Phase 4B: Setup & Pairing Pages         │
         ├── Phase 4C: Home Page ◄───────────────────┘
         ├── Phase 4D: Folder View Page
         └── Phase 4E: Video Player Page
              │
              └── Phase 5: Polish & Integration
```

**Parallelism:** Phase 2 tasks (A-D) can all run in parallel. Phase 3 depends on 2A only. Phase 4 tasks depend on their respective Phase 2/3 prerequisites but can run in parallel with each other.

---

## Phase 1: Project Foundation

### Task 1: Initialize Next.js Project

**Step 1: Create the Next.js app**

Run:
```bash
cd F:/Projects/tv-video-ui
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

When prompted, accept defaults. Use `src/` directory: yes. App Router: yes.

**Step 2: Install dependencies**

Run:
```bash
npm install framer-motion video.js @vercel/kv uuid qrcode react-qrcode-logo
npm install -D @types/uuid @types/video.js
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: initialize Next.js project with dependencies"
```

---

### Task 2: Configure Tailwind Theme & Global Styles

**Files:**
- Modify: `src/app/globals.css`
- Modify: `tailwind.config.ts`

**Step 1: Configure Tailwind with TV-optimized theme**

Replace `tailwind.config.ts` with:

```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        tv: {
          bg: "#0a0a0f",
          surface: "#14141f",
          card: "#1a1a2e",
          border: "#2a2a3e",
          focus: "#4f8fff",
          "focus-glow": "rgba(79, 143, 255, 0.4)",
          text: "#e8e8f0",
          "text-dim": "#8888a0",
          accent: "#4f8fff",
          progress: "#4f8fff",
          warning: "#ff6b4f",
        },
      },
      spacing: {
        "card-gap": "1.5rem",
        "row-gap": "2.5rem",
        "tv-padding": "3rem",
      },
      fontSize: {
        "tv-xs": ["1rem", "1.4"],
        "tv-sm": ["1.25rem", "1.4"],
        "tv-base": ["1.5rem", "1.5"],
        "tv-lg": ["2rem", "1.3"],
        "tv-xl": ["2.5rem", "1.2"],
        "tv-2xl": ["3.5rem", "1.1"],
      },
      borderRadius: {
        card: "0.75rem",
      },
      transitionDuration: {
        focus: "200ms",
      },
      scale: {
        focus: "1.08",
      },
      boxShadow: {
        "tv-focus":
          "0 0 0 3px rgba(79, 143, 255, 0.6), 0 8px 32px rgba(79, 143, 255, 0.3)",
        "tv-card": "0 4px 16px rgba(0, 0, 0, 0.4)",
      },
    },
  },
  plugins: [],
};
export default config;
```

**Step 2: Set up global styles**

Replace `src/app/globals.css` with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --tv-bg: #0a0a0f;
  --tv-focus: #4f8fff;
}

* {
  -webkit-tap-highlight-color: transparent;
}

html {
  font-size: 16px;
  background: var(--tv-bg);
  color: #e8e8f0;
  overflow: hidden;
}

body {
  min-height: 100vh;
  background: var(--tv-bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Hide scrollbars globally — TV UI scrolls programmatically */
::-webkit-scrollbar {
  display: none;
}

* {
  scrollbar-width: none;
}

/* Focus outline removal — we handle focus visually via our D-pad system */
*:focus {
  outline: none;
}

/* GPU-accelerated transforms for smooth TV animations */
.tv-card {
  will-change: transform;
  transform: translateZ(0);
}

/* Smooth scroll for rows */
.tv-scroll-row {
  scroll-behavior: smooth;
  scroll-snap-type: x mandatory;
}

.tv-scroll-row > * {
  scroll-snap-align: start;
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

**Step 3: Commit**

```bash
git add tailwind.config.ts src/app/globals.css
git commit -m "feat: configure Tailwind TV theme and global styles"
```

---

### Task 3: Set Up Directory Structure & Shared Types

**Files:**
- Create: `src/types/index.ts`
- Create: `src/lib/constants.ts`
- Modify: `src/app/layout.tsx`

**Step 1: Create shared TypeScript types**

Create `src/types/index.ts`:

```ts
export type CloudProvider = "google" | "onedrive";

export interface CloudConnection {
  id: string;
  provider: CloudProvider;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
  email: string;
  folders: CloudFolder[];
}

export interface CloudFolder {
  id: string;
  name: string;
  provider: CloudProvider;
  connectionId: string;
}

export interface VideoFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  thumbnailUrl: string | null;
  provider: CloudProvider;
  connectionId: string;
  folderId: string;
  createdAt: string;
  modifiedAt: string;
}

export interface FolderItem {
  id: string;
  name: string;
  provider: CloudProvider;
  connectionId: string;
  parentId: string;
}

export type BrowseItem =
  | ({ type: "video" } & VideoFile)
  | ({ type: "folder" } & FolderItem);

export interface WatchHistory {
  fileId: string;
  provider: CloudProvider;
  position: number;
  duration: number;
  lastWatched: string;
}

export interface PairingSession {
  code: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

export interface StreamUrlResponse {
  url: string;
  expiresAt: number;
}
```

**Step 2: Create constants**

Create `src/lib/constants.ts`:

```ts
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
export const POLL_INTERVAL_MS = 3000;
export const WATCH_HISTORY_SAVE_INTERVAL_MS = 30_000; // 30 seconds
export const CONTROLS_AUTO_HIDE_MS = 5000;
export const SEEK_STEP_SECONDS = 10;
export const SEEK_LONG_STEP_SECONDS = 30;
export const BUFFER_AHEAD_SECONDS = 120;
export const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v"];
export const VIDEO_MIME_PREFIXES = ["video/mp4", "video/webm", "video/quicktime"];

export const KV_KEYS = {
  connections: (sessionId: string) => `connections:${sessionId}`,
  watchHistory: (sessionId: string, fileId: string) =>
    `watch-history:${sessionId}:${fileId}`,
  pairing: (code: string) => `pairing:${code}`,
  session: (sessionId: string) => `session:${sessionId}`,
} as const;

export const GOOGLE_OAUTH = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/drive.readonly",
  apiBase: "https://www.googleapis.com/drive/v3",
} as const;

export const ONEDRIVE_OAUTH = {
  authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scope: "Files.Read offline_access",
  apiBase: "https://graph.microsoft.com/v1.0",
} as const;
```

**Step 3: Update root layout**

Replace `src/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TV Video",
  description: "Stream your cloud videos on your TV",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-tv-bg text-tv-text`}>
        {children}
      </body>
    </html>
  );
}
```

**Step 4: Commit**

```bash
git add src/types/index.ts src/lib/constants.ts src/app/layout.tsx
git commit -m "feat: add shared types, constants, and root layout"
```

---

## Phase 2A: D-Pad Navigation System

> Can run in parallel with 2B, 2C, 2D

### Task 4: Build the D-Pad Focus Manager

**Files:**
- Create: `src/lib/navigation/focus-context.tsx`
- Create: `src/lib/navigation/use-dpad.ts`
- Create: `src/lib/navigation/use-focusable.ts`
- Create: `src/lib/navigation/index.ts`

**Step 1: Create the focus context**

Create `src/lib/navigation/focus-context.tsx`:

```tsx
"use client";

import React, {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
} from "react";

interface FocusableElement {
  id: string;
  element: HTMLElement;
  row: number;
  col: number;
  onSelect?: () => void;
}

interface FocusContextType {
  focusedId: string | null;
  register: (item: FocusableElement) => void;
  unregister: (id: string) => void;
  setFocus: (id: string) => void;
  moveFocus: (direction: "up" | "down" | "left" | "right") => void;
  selectFocused: () => void;
}

const FocusContext = createContext<FocusContextType | null>(null);

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const itemsRef = useRef<Map<string, FocusableElement>>(new Map());

  const register = useCallback(
    (item: FocusableElement) => {
      itemsRef.current.set(item.id, item);
      // Auto-focus first registered item if nothing is focused
      if (focusedId === null && itemsRef.current.size === 1) {
        setFocusedId(item.id);
      }
    },
    [focusedId]
  );

  const unregister = useCallback(
    (id: string) => {
      itemsRef.current.delete(id);
      if (focusedId === id) {
        // Move focus to nearest neighbor
        const remaining = Array.from(itemsRef.current.values());
        if (remaining.length > 0) {
          setFocusedId(remaining[0].id);
        } else {
          setFocusedId(null);
        }
      }
    },
    [focusedId]
  );

  const setFocus = useCallback((id: string) => {
    if (itemsRef.current.has(id)) {
      setFocusedId(id);
      const item = itemsRef.current.get(id);
      item?.element?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, []);

  const moveFocus = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const items = Array.from(itemsRef.current.values());
      if (items.length === 0) return;

      const current = items.find((i) => i.id === focusedId);
      if (!current) {
        setFocusedId(items[0].id);
        return;
      }

      let candidates: FocusableElement[] = [];

      switch (direction) {
        case "left":
          candidates = items.filter(
            (i) => i.row === current.row && i.col < current.col
          );
          candidates.sort((a, b) => b.col - a.col); // closest first
          break;
        case "right":
          candidates = items.filter(
            (i) => i.row === current.row && i.col > current.col
          );
          candidates.sort((a, b) => a.col - b.col);
          break;
        case "up":
          candidates = items.filter((i) => i.row < current.row);
          candidates.sort((a, b) => {
            const rowDiff = b.row - a.row; // closest row first
            if (rowDiff !== 0) return rowDiff;
            return Math.abs(a.col - current.col) - Math.abs(b.col - current.col);
          });
          break;
        case "down":
          candidates = items.filter((i) => i.row > current.row);
          candidates.sort((a, b) => {
            const rowDiff = a.row - b.row;
            if (rowDiff !== 0) return rowDiff;
            return Math.abs(a.col - current.col) - Math.abs(b.col - current.col);
          });
          break;
      }

      if (candidates.length > 0) {
        const next = candidates[0];
        setFocusedId(next.id);
        next.element?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "nearest",
        });
      }
    },
    [focusedId]
  );

  const selectFocused = useCallback(() => {
    if (!focusedId) return;
    const item = itemsRef.current.get(focusedId);
    item?.onSelect?.();
  }, [focusedId]);

  return (
    <FocusContext.Provider
      value={{ focusedId, register, unregister, setFocus, moveFocus, selectFocused }}
    >
      {children}
    </FocusContext.Provider>
  );
}

export function useFocusContext() {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error("useFocusContext must be used within FocusProvider");
  return ctx;
}
```

**Step 2: Create the D-pad keyboard hook**

Create `src/lib/navigation/use-dpad.ts`:

```ts
"use client";

import { useEffect } from "react";
import { useFocusContext } from "./focus-context";

interface UseDpadOptions {
  onBack?: () => void;
  enabled?: boolean;
}

export function useDpad({ onBack, enabled = true }: UseDpadOptions = {}) {
  const { moveFocus, selectFocused } = useFocusContext();

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          moveFocus("up");
          break;
        case "ArrowDown":
          e.preventDefault();
          moveFocus("down");
          break;
        case "ArrowLeft":
          e.preventDefault();
          moveFocus("left");
          break;
        case "ArrowRight":
          e.preventDefault();
          moveFocus("right");
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          selectFocused();
          break;
        case "Escape":
        case "Backspace":
          e.preventDefault();
          onBack?.();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [moveFocus, selectFocused, onBack, enabled]);
}
```

**Step 3: Create the focusable element hook**

Create `src/lib/navigation/use-focusable.ts`:

```ts
"use client";

import { useEffect, useRef } from "react";
import { useFocusContext } from "./focus-context";

interface UseFocusableOptions {
  id: string;
  row: number;
  col: number;
  onSelect?: () => void;
}

export function useFocusable({ id, row, col, onSelect }: UseFocusableOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const { focusedId, register, unregister } = useFocusContext();
  const isFocused = focusedId === id;

  useEffect(() => {
    if (ref.current) {
      register({ id, element: ref.current, row, col, onSelect });
    }
    return () => unregister(id);
  }, [id, row, col, onSelect, register, unregister]);

  return { ref, isFocused };
}
```

**Step 4: Create barrel export**

Create `src/lib/navigation/index.ts`:

```ts
export { FocusProvider, useFocusContext } from "./focus-context";
export { useDpad } from "./use-dpad";
export { useFocusable } from "./use-focusable";
```

**Step 5: Commit**

```bash
git add src/lib/navigation/
git commit -m "feat: implement D-pad spatial navigation system"
```

---

## Phase 2B: Vercel KV & Session Management

> Can run in parallel with 2A, 2C, 2D

### Task 5: Build KV Storage Helpers

**Files:**
- Create: `src/lib/kv/storage.ts`
- Create: `src/lib/kv/session.ts`
- Create: `src/lib/kv/index.ts`

**Step 1: Create storage helpers**

Create `src/lib/kv/storage.ts`:

```ts
import { kv } from "@vercel/kv";
import { KV_KEYS, PAIRING_CODE_EXPIRY_MS, PAIRING_CODE_LENGTH } from "../constants";
import type {
  CloudConnection,
  WatchHistory,
  PairingSession,
} from "@/types";
import { v4 as uuid } from "uuid";

// --- Connections ---

export async function getConnections(
  sessionId: string
): Promise<CloudConnection[]> {
  const data = await kv.get<CloudConnection[]>(KV_KEYS.connections(sessionId));
  return data ?? [];
}

export async function saveConnection(
  sessionId: string,
  connection: CloudConnection
): Promise<void> {
  const existing = await getConnections(sessionId);
  const idx = existing.findIndex((c) => c.id === connection.id);
  if (idx >= 0) {
    existing[idx] = connection;
  } else {
    existing.push(connection);
  }
  await kv.set(KV_KEYS.connections(sessionId), existing);
}

export async function removeConnection(
  sessionId: string,
  connectionId: string
): Promise<void> {
  const existing = await getConnections(sessionId);
  const filtered = existing.filter((c) => c.id !== connectionId);
  await kv.set(KV_KEYS.connections(sessionId), filtered);
}

export async function updateTokens(
  sessionId: string,
  connectionId: string,
  accessToken: string,
  tokenExpiry: number
): Promise<void> {
  const connections = await getConnections(sessionId);
  const conn = connections.find((c) => c.id === connectionId);
  if (conn) {
    conn.accessToken = accessToken;
    conn.tokenExpiry = tokenExpiry;
    await kv.set(KV_KEYS.connections(sessionId), connections);
  }
}

// --- Watch History ---

export async function getWatchHistory(
  sessionId: string,
  fileId: string
): Promise<WatchHistory | null> {
  return kv.get<WatchHistory>(KV_KEYS.watchHistory(sessionId, fileId));
}

export async function saveWatchHistory(
  sessionId: string,
  history: WatchHistory
): Promise<void> {
  await kv.set(KV_KEYS.watchHistory(sessionId, history.fileId), history);
}

// --- Pairing ---

function generatePairingCode(): string {
  const chars = "0123456789";
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `TV-${code}`;
}

export async function createPairingSession(): Promise<PairingSession> {
  const code = generatePairingCode();
  const sessionId = uuid();
  const now = Date.now();
  const session: PairingSession = {
    code,
    sessionId,
    createdAt: now,
    expiresAt: now + PAIRING_CODE_EXPIRY_MS,
  };
  await kv.set(KV_KEYS.pairing(code), session, {
    ex: Math.ceil(PAIRING_CODE_EXPIRY_MS / 1000),
  });
  return session;
}

export async function getPairingSession(
  code: string
): Promise<PairingSession | null> {
  const session = await kv.get<PairingSession>(KV_KEYS.pairing(code));
  if (!session) return null;
  if (Date.now() > session.expiresAt) return null;
  return session;
}

export async function deletePairingSession(code: string): Promise<void> {
  await kv.del(KV_KEYS.pairing(code));
}
```

**Step 2: Create session validation helper**

Create `src/lib/kv/session.ts`:

```ts
import { cookies } from "next/headers";
import { getConnections } from "./storage";

const SESSION_COOKIE = "tv-session-id";

export async function getSessionId(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? null;
}

export async function validateSession(
  sessionId: string
): Promise<boolean> {
  const connections = await getConnections(sessionId);
  return connections.length > 0;
}
```

**Step 3: Barrel export**

Create `src/lib/kv/index.ts`:

```ts
export {
  getConnections,
  saveConnection,
  removeConnection,
  updateTokens,
  getWatchHistory,
  saveWatchHistory,
  createPairingSession,
  getPairingSession,
  deletePairingSession,
} from "./storage";
export { getSessionId, validateSession } from "./session";
```

**Step 4: Commit**

```bash
git add src/lib/kv/
git commit -m "feat: add Vercel KV storage and session helpers"
```

---

## Phase 2C: Google Drive API Client

> Can run in parallel with 2A, 2B, 2D

### Task 6: Build Google Drive Client

**Files:**
- Create: `src/lib/cloud/google-drive.ts`

**Step 1: Implement the Google Drive client**

Create `src/lib/cloud/google-drive.ts`:

```ts
import { GOOGLE_OAUTH } from "../constants";
import { updateTokens } from "../kv/storage";
import type { BrowseItem, CloudConnection } from "@/types";

async function refreshAccessToken(
  sessionId: string,
  connection: CloudConnection
): Promise<string> {
  if (Date.now() < connection.tokenExpiry - 60_000) {
    return connection.accessToken;
  }

  const res = await fetch(GOOGLE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status}`);
  }

  const data = await res.json();
  const newExpiry = Date.now() + data.expires_in * 1000;
  await updateTokens(sessionId, connection.id, data.access_token, newExpiry);
  return data.access_token;
}

export async function listGoogleDriveFiles(
  sessionId: string,
  connection: CloudConnection,
  folderId: string
): Promise<BrowseItem[]> {
  const token = await refreshAccessToken(sessionId, connection);

  const query = `'${folderId}' in parents and trashed = false`;
  const fields =
    "files(id,name,mimeType,size,thumbnailLink,createdTime,modifiedTime)";

  const res = await fetch(
    `${GOOGLE_OAUTH.apiBase}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&pageSize=100&orderBy=name`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!res.ok) {
    throw new Error(`Google Drive list failed: ${res.status}`);
  }

  const data = await res.json();
  const items: BrowseItem[] = [];

  for (const file of data.files ?? []) {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      items.push({
        type: "folder",
        id: file.id,
        name: file.name,
        provider: "google",
        connectionId: connection.id,
        parentId: folderId,
      });
    } else if (file.mimeType?.startsWith("video/")) {
      items.push({
        type: "video",
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: Number(file.size ?? 0),
        thumbnailUrl: file.thumbnailLink ?? null,
        provider: "google",
        connectionId: connection.id,
        folderId,
        createdAt: file.createdTime,
        modifiedAt: file.modifiedTime,
      });
    }
  }

  return items;
}

export async function getGoogleDriveStreamUrl(
  sessionId: string,
  connection: CloudConnection,
  fileId: string
): Promise<string> {
  const token = await refreshAccessToken(sessionId, connection);

  // Return the direct download URL with auth token
  // The client will use this URL directly to stream
  return `${GOOGLE_OAUTH.apiBase}/files/${fileId}?alt=media&access_token=${encodeURIComponent(token)}`;
}

export function getGoogleOAuthUrl(
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH.scope,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_OAUTH.authUrl}?${params}`;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; email: string }> {
  const res = await fetch(GOOGLE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google code exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  // Get user email
  const userRes = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${data.access_token}` } }
  );
  const user = await userRes.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    email: user.email ?? "unknown",
  };
}

export async function listGoogleDriveFolders(
  token: string,
  parentId: string = "root"
): Promise<Array<{ id: string; name: string }>> {
  const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await fetch(
    `${GOOGLE_OAUTH.apiBase}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=100&orderBy=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Google folder list failed: ${res.status}`);
  const data = await res.json();
  return data.files ?? [];
}
```

**Step 2: Commit**

```bash
git add src/lib/cloud/google-drive.ts
git commit -m "feat: add Google Drive API client"
```

---

## Phase 2D: OneDrive API Client

> Can run in parallel with 2A, 2B, 2C

### Task 7: Build OneDrive Client

**Files:**
- Create: `src/lib/cloud/onedrive.ts`
- Create: `src/lib/cloud/index.ts`

**Step 1: Implement the OneDrive client**

Create `src/lib/cloud/onedrive.ts`:

```ts
import { ONEDRIVE_OAUTH } from "../constants";
import { updateTokens } from "../kv/storage";
import type { BrowseItem, CloudConnection } from "@/types";

async function refreshAccessToken(
  sessionId: string,
  connection: CloudConnection
): Promise<string> {
  if (Date.now() < connection.tokenExpiry - 60_000) {
    return connection.accessToken;
  }

  const res = await fetch(ONEDRIVE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.ONEDRIVE_CLIENT_ID!,
      client_secret: process.env.ONEDRIVE_CLIENT_SECRET!,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
      scope: ONEDRIVE_OAUTH.scope,
    }),
  });

  if (!res.ok) {
    throw new Error(`OneDrive token refresh failed: ${res.status}`);
  }

  const data = await res.json();
  const newExpiry = Date.now() + data.expires_in * 1000;
  await updateTokens(sessionId, connection.id, data.access_token, newExpiry);
  return data.access_token;
}

export async function listOneDriveFiles(
  sessionId: string,
  connection: CloudConnection,
  folderId: string
): Promise<BrowseItem[]> {
  const token = await refreshAccessToken(sessionId, connection);

  const endpoint =
    folderId === "root"
      ? `${ONEDRIVE_OAUTH.apiBase}/me/drive/root/children`
      : `${ONEDRIVE_OAUTH.apiBase}/me/drive/items/${folderId}/children`;

  const res = await fetch(
    `${endpoint}?$top=200&$orderby=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    throw new Error(`OneDrive list failed: ${res.status}`);
  }

  const data = await res.json();
  const items: BrowseItem[] = [];

  for (const item of data.value ?? []) {
    if (item.folder) {
      items.push({
        type: "folder",
        id: item.id,
        name: item.name,
        provider: "onedrive",
        connectionId: connection.id,
        parentId: folderId,
      });
    } else if (item.file?.mimeType?.startsWith("video/")) {
      items.push({
        type: "video",
        id: item.id,
        name: item.name,
        mimeType: item.file.mimeType,
        size: item.size ?? 0,
        thumbnailUrl: null, // fetched separately
        provider: "onedrive",
        connectionId: connection.id,
        folderId,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
      });
    }
  }

  // Fetch thumbnails for video items
  const videoItems = items.filter((i) => i.type === "video");
  await Promise.all(
    videoItems.map(async (item) => {
      try {
        const thumbRes = await fetch(
          `${ONEDRIVE_OAUTH.apiBase}/me/drive/items/${item.id}/thumbnails/0/large`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (thumbRes.ok) {
          const thumbData = await thumbRes.json();
          if (item.type === "video") {
            item.thumbnailUrl = thumbData.url ?? null;
          }
        }
      } catch {
        // thumbnail fetch is best-effort
      }
    })
  );

  return items;
}

export async function getOneDriveStreamUrl(
  sessionId: string,
  connection: CloudConnection,
  fileId: string
): Promise<string> {
  const token = await refreshAccessToken(sessionId, connection);

  const res = await fetch(
    `${ONEDRIVE_OAUTH.apiBase}/me/drive/items/${fileId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    throw new Error(`OneDrive file fetch failed: ${res.status}`);
  }

  const data = await res.json();
  const downloadUrl = data["@microsoft.graph.downloadUrl"];
  if (!downloadUrl) {
    throw new Error("No download URL available for this file");
  }

  return downloadUrl;
}

export function getOneDriveOAuthUrl(
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: process.env.ONEDRIVE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ONEDRIVE_OAUTH.scope,
    state,
  });
  return `${ONEDRIVE_OAUTH.authUrl}?${params}`;
}

export async function exchangeOneDriveCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; email: string }> {
  const res = await fetch(ONEDRIVE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.ONEDRIVE_CLIENT_ID!,
      client_secret: process.env.ONEDRIVE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      scope: ONEDRIVE_OAUTH.scope,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OneDrive code exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  // Get user info
  const userRes = await fetch(`${ONEDRIVE_OAUTH.apiBase}/me`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const user = await userRes.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    email: user.mail ?? user.userPrincipalName ?? "unknown",
  };
}

export async function listOneDriveFolders(
  token: string,
  parentId: string = "root"
): Promise<Array<{ id: string; name: string }>> {
  const endpoint =
    parentId === "root"
      ? `${ONEDRIVE_OAUTH.apiBase}/me/drive/root/children`
      : `${ONEDRIVE_OAUTH.apiBase}/me/drive/items/${parentId}/children`;

  const res = await fetch(
    `${endpoint}?$filter=folder ne null&$top=100&$orderby=name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`OneDrive folder list failed: ${res.status}`);
  const data = await res.json();
  return (data.value ?? []).map((f: { id: string; name: string }) => ({
    id: f.id,
    name: f.name,
  }));
}
```

**Step 2: Create cloud client barrel export**

Create `src/lib/cloud/index.ts`:

```ts
export {
  listGoogleDriveFiles,
  getGoogleDriveStreamUrl,
  getGoogleOAuthUrl,
  exchangeGoogleCode,
  listGoogleDriveFolders,
} from "./google-drive";

export {
  listOneDriveFiles,
  getOneDriveStreamUrl,
  getOneDriveOAuthUrl,
  exchangeOneDriveCode,
  listOneDriveFolders,
} from "./onedrive";
```

**Step 3: Create env template**

Create `.env.example`:

```
# Google Drive OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# OneDrive OAuth
ONEDRIVE_CLIENT_ID=
ONEDRIVE_CLIENT_SECRET=

# Vercel KV (auto-populated when you link Vercel KV)
KV_REST_API_URL=
KV_REST_API_TOKEN=

# App URL (for OAuth callbacks)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**Step 4: Commit**

```bash
git add src/lib/cloud/ .env.example
git commit -m "feat: add OneDrive API client and cloud module"
```

---

## Phase 3: UI Components

> Depends on Phase 1 and Phase 2A (navigation). Can run in parallel with Phase 2B-D.

### Task 8: Build VideoCard Component

**Files:**
- Create: `src/components/video-card.tsx`

**Step 1: Implement VideoCard**

Create `src/components/video-card.tsx`:

```tsx
"use client";

import { useFocusable } from "@/lib/navigation";
import type { VideoFile, WatchHistory } from "@/types";

interface VideoCardProps {
  video: VideoFile;
  watchHistory?: WatchHistory | null;
  focusId: string;
  row: number;
  col: number;
  onSelect: () => void;
}

export function VideoCard({
  video,
  watchHistory,
  focusId,
  row,
  col,
  onSelect,
}: VideoCardProps) {
  const { ref, isFocused } = useFocusable({
    id: focusId,
    row,
    col,
    onSelect,
  });

  const progress =
    watchHistory && watchHistory.duration > 0
      ? (watchHistory.position / watchHistory.duration) * 100
      : 0;

  const displayName = video.name.replace(/\.[^/.]+$/, ""); // strip extension

  return (
    <div
      ref={ref}
      className={`
        tv-card relative flex-shrink-0 w-[300px] h-[170px] rounded-card overflow-hidden cursor-pointer
        transition-all duration-focus ease-out
        ${isFocused
          ? "scale-focus shadow-tv-focus z-10 ring-2 ring-tv-focus"
          : "scale-100 shadow-tv-card"
        }
      `}
    >
      {/* Thumbnail */}
      {video.thumbnailUrl ? (
        <img
          src={video.thumbnailUrl}
          alt={displayName}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="absolute inset-0 bg-tv-card flex items-center justify-center">
          <svg
            className="w-16 h-16 text-tv-text-dim"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
      )}

      {/* Title gradient overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 pt-8">
        <p
          className={`text-tv-xs font-medium truncate transition-all duration-focus ${
            isFocused ? "text-white" : "text-tv-text"
          }`}
        >
          {displayName}
        </p>
      </div>

      {/* Watch progress bar */}
      {progress > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-1">
          <div className="h-full bg-white/20">
            <div
              className="h-full bg-tv-progress"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/video-card.tsx
git commit -m "feat: add VideoCard component with focus and progress"
```

---

### Task 9: Build FolderCard Component

**Files:**
- Create: `src/components/folder-card.tsx`

**Step 1: Implement FolderCard**

Create `src/components/folder-card.tsx`:

```tsx
"use client";

import { useFocusable } from "@/lib/navigation";
import type { FolderItem } from "@/types";

interface FolderCardProps {
  folder: FolderItem;
  focusId: string;
  row: number;
  col: number;
  onSelect: () => void;
}

export function FolderCard({
  folder,
  focusId,
  row,
  col,
  onSelect,
}: FolderCardProps) {
  const { ref, isFocused } = useFocusable({
    id: focusId,
    row,
    col,
    onSelect,
  });

  return (
    <div
      ref={ref}
      className={`
        tv-card relative flex-shrink-0 w-[300px] h-[170px] rounded-card overflow-hidden cursor-pointer
        transition-all duration-focus ease-out
        ${isFocused
          ? "scale-focus shadow-tv-focus z-10 ring-2 ring-tv-focus"
          : "scale-100 shadow-tv-card"
        }
      `}
    >
      {/* Folder background */}
      <div className="absolute inset-0 bg-gradient-to-br from-tv-card to-tv-surface flex flex-col items-center justify-center gap-2">
        <svg
          className={`w-16 h-16 transition-colors duration-focus ${
            isFocused ? "text-tv-focus" : "text-tv-text-dim"
          }`}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
        </svg>
        <p
          className={`text-tv-sm font-medium text-center px-4 truncate max-w-full transition-colors duration-focus ${
            isFocused ? "text-white" : "text-tv-text"
          }`}
        >
          {folder.name}
        </p>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/folder-card.tsx
git commit -m "feat: add FolderCard component"
```

---

### Task 10: Build ContentRow Component (Netflix-style horizontal row)

**Files:**
- Create: `src/components/content-row.tsx`

**Step 1: Implement ContentRow**

Create `src/components/content-row.tsx`:

```tsx
"use client";

import { useRef } from "react";
import { motion } from "framer-motion";
import { VideoCard } from "./video-card";
import { FolderCard } from "./folder-card";
import type { BrowseItem, WatchHistory } from "@/types";

interface ContentRowProps {
  title: string;
  items: BrowseItem[];
  rowIndex: number;
  watchHistories?: Map<string, WatchHistory>;
  onVideoSelect: (videoId: string, provider: string, connectionId: string) => void;
  onFolderSelect: (folderId: string, provider: string, connectionId: string) => void;
}

export function ContentRow({
  title,
  items,
  rowIndex,
  watchHistories,
  onVideoSelect,
  onFolderSelect,
}: ContentRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sort: folders first, then videos
  const sorted = [...items].sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: rowIndex * 0.1, duration: 0.3 }}
      className="mb-row-gap"
    >
      <h2 className="text-tv-lg font-semibold mb-4 px-tv-padding">{title}</h2>
      <div
        ref={scrollRef}
        className="tv-scroll-row flex gap-card-gap px-tv-padding overflow-x-auto pb-4"
      >
        {sorted.map((item, colIndex) => {
          if (item.type === "folder") {
            return (
              <FolderCard
                key={`folder-${item.id}`}
                folder={item}
                focusId={`row${rowIndex}-col${colIndex}`}
                row={rowIndex}
                col={colIndex}
                onSelect={() =>
                  onFolderSelect(item.id, item.provider, item.connectionId)
                }
              />
            );
          }
          return (
            <VideoCard
              key={`video-${item.id}`}
              video={item}
              watchHistory={watchHistories?.get(item.id)}
              focusId={`row${rowIndex}-col${colIndex}`}
              row={rowIndex}
              col={colIndex}
              onSelect={() =>
                onVideoSelect(item.id, item.provider, item.connectionId)
              }
            />
          );
        })}
      </div>
    </motion.div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/content-row.tsx
git commit -m "feat: add ContentRow component with horizontal scroll"
```

---

### Task 11: Build ContentGrid Component (Folder view)

**Files:**
- Create: `src/components/content-grid.tsx`
- Create: `src/components/breadcrumb.tsx`

**Step 1: Implement ContentGrid**

Create `src/components/content-grid.tsx`:

```tsx
"use client";

import { motion } from "framer-motion";
import { VideoCard } from "./video-card";
import { FolderCard } from "./folder-card";
import type { BrowseItem, WatchHistory } from "@/types";

interface ContentGridProps {
  items: BrowseItem[];
  watchHistories?: Map<string, WatchHistory>;
  onVideoSelect: (videoId: string, provider: string, connectionId: string) => void;
  onFolderSelect: (folderId: string, provider: string, connectionId: string) => void;
}

const COLUMNS = 5;

export function ContentGrid({
  items,
  watchHistories,
  onVideoSelect,
  onFolderSelect,
}: ContentGridProps) {
  // Sort: folders first, then videos
  const sorted = [...items].sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-card-gap px-tv-padding py-4">
      {sorted.map((item, index) => {
        const row = Math.floor(index / COLUMNS);
        const col = index % COLUMNS;

        if (item.type === "folder") {
          return (
            <motion.div
              key={`folder-${item.id}`}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.03, duration: 0.25 }}
            >
              <FolderCard
                folder={item}
                focusId={`grid-r${row}-c${col}`}
                row={row + 1} // row 0 reserved for breadcrumb
                col={col}
                onSelect={() =>
                  onFolderSelect(item.id, item.provider, item.connectionId)
                }
              />
            </motion.div>
          );
        }
        return (
          <motion.div
            key={`video-${item.id}`}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.03, duration: 0.25 }}
          >
            <VideoCard
              video={item}
              watchHistory={watchHistories?.get(item.id)}
              focusId={`grid-r${row}-c${col}`}
              row={row + 1}
              col={col}
              onSelect={() =>
                onVideoSelect(item.id, item.provider, item.connectionId)
              }
            />
          </motion.div>
        );
      })}
    </div>
  );
}
```

**Step 2: Implement Breadcrumb**

Create `src/components/breadcrumb.tsx`:

```tsx
"use client";

import { useFocusable } from "@/lib/navigation";

interface BreadcrumbSegment {
  label: string;
  href: string;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  onNavigate: (href: string) => void;
}

export function Breadcrumb({ segments, onNavigate }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-2 px-tv-padding py-4">
      {segments.map((segment, i) => (
        <BreadcrumbItem
          key={segment.href}
          segment={segment}
          isLast={i === segments.length - 1}
          col={i}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

function BreadcrumbItem({
  segment,
  isLast,
  col,
  onNavigate,
}: {
  segment: BreadcrumbSegment;
  isLast: boolean;
  col: number;
  onNavigate: (href: string) => void;
}) {
  const { ref, isFocused } = useFocusable({
    id: `breadcrumb-${col}`,
    row: 0,
    col,
    onSelect: () => onNavigate(segment.href),
  });

  return (
    <>
      {col > 0 && (
        <span className="text-tv-text-dim text-tv-sm">/</span>
      )}
      <div
        ref={ref}
        className={`
          text-tv-sm px-3 py-1 rounded-lg cursor-pointer transition-all duration-focus
          ${isLast ? "text-tv-text font-semibold" : "text-tv-text-dim"}
          ${isFocused ? "bg-tv-focus/20 text-white ring-2 ring-tv-focus" : ""}
        `}
      >
        {segment.label}
      </div>
    </>
  );
}
```

**Step 3: Create component barrel export**

Create `src/components/index.ts`:

```ts
export { VideoCard } from "./video-card";
export { FolderCard } from "./folder-card";
export { ContentRow } from "./content-row";
export { ContentGrid } from "./content-grid";
export { Breadcrumb } from "./breadcrumb";
```

**Step 4: Commit**

```bash
git add src/components/content-grid.tsx src/components/breadcrumb.tsx src/components/index.ts
git commit -m "feat: add ContentGrid and Breadcrumb components"
```

---

## Phase 4A: API Routes

> Depends on Phase 2B, 2C, 2D

### Task 12: Build Stream URL API Route

**Files:**
- Create: `src/app/api/stream-url/route.ts`

**Step 1: Implement the stream URL endpoint**

Create `src/app/api/stream-url/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConnections } from "@/lib/kv";
import { getGoogleDriveStreamUrl } from "@/lib/cloud/google-drive";
import { getOneDriveStreamUrl } from "@/lib/cloud/onedrive";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("fileId");
  const provider = searchParams.get("provider");
  const connectionId = searchParams.get("connectionId");
  const sessionId = searchParams.get("sessionId");

  if (!fileId || !provider || !connectionId || !sessionId) {
    return NextResponse.json(
      { error: "Missing required parameters" },
      { status: 400 }
    );
  }

  try {
    const connections = await getConnections(sessionId);
    const connection = connections.find((c) => c.id === connectionId);

    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    let url: string;

    if (provider === "google") {
      url = await getGoogleDriveStreamUrl(sessionId, connection, fileId);
    } else if (provider === "onedrive") {
      url = await getOneDriveStreamUrl(sessionId, connection, fileId);
    } else {
      return NextResponse.json(
        { error: "Unsupported provider" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      url,
      expiresAt: Date.now() + 3600_000, // approximate 1hr expiry
    });
  } catch (error) {
    console.error("Stream URL error:", error);
    return NextResponse.json(
      { error: "Failed to generate stream URL" },
      { status: 500 }
    );
  }
}
```

**Step 2: Commit**

```bash
git add src/app/api/stream-url/route.ts
git commit -m "feat: add stream URL API route"
```

---

### Task 13: Build Pairing & Status API Routes

**Files:**
- Create: `src/app/api/pairing/route.ts`
- Create: `src/app/api/pairing/status/route.ts`

**Step 1: Implement pairing creation endpoint**

Create `src/app/api/pairing/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createPairingSession } from "@/lib/kv";

export async function POST() {
  try {
    const session = await createPairingSession();
    return NextResponse.json({
      code: session.code,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.error("Pairing creation error:", error);
    return NextResponse.json(
      { error: "Failed to create pairing session" },
      { status: 500 }
    );
  }
}
```

**Step 2: Implement pairing status polling endpoint**

Create `src/app/api/pairing/status/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getPairingSession, getConnections } from "@/lib/kv";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  try {
    const session = await getPairingSession(code);

    if (!session) {
      return NextResponse.json(
        { error: "Pairing session expired or not found" },
        { status: 404 }
      );
    }

    // Check if any connections have been added for this session
    const connections = await getConnections(session.sessionId);
    const paired = connections.length > 0;

    return NextResponse.json({
      paired,
      sessionId: paired ? session.sessionId : undefined,
    });
  } catch (error) {
    console.error("Pairing status error:", error);
    return NextResponse.json(
      { error: "Failed to check pairing status" },
      { status: 500 }
    );
  }
}
```

**Step 3: Commit**

```bash
git add src/app/api/pairing/
git commit -m "feat: add pairing and status polling API routes"
```

---

### Task 14: Build Watch History API Route

**Files:**
- Create: `src/app/api/watch-history/route.ts`

**Step 1: Implement watch history endpoint**

Create `src/app/api/watch-history/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getWatchHistory, saveWatchHistory } from "@/lib/kv";
import type { WatchHistory } from "@/types";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const fileId = request.nextUrl.searchParams.get("fileId");

  if (!sessionId || !fileId) {
    return NextResponse.json(
      { error: "Missing sessionId or fileId" },
      { status: 400 }
    );
  }

  try {
    const history = await getWatchHistory(sessionId, fileId);
    return NextResponse.json({ history });
  } catch (error) {
    console.error("Watch history GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch watch history" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, fileId, provider, position, duration } = body;

    if (!sessionId || !fileId || !provider || position == null || !duration) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const history: WatchHistory = {
      fileId,
      provider,
      position,
      duration,
      lastWatched: new Date().toISOString(),
    };

    await saveWatchHistory(sessionId, history);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Watch history POST error:", error);
    return NextResponse.json(
      { error: "Failed to save watch history" },
      { status: 500 }
    );
  }
}
```

**Step 2: Commit**

```bash
git add src/app/api/watch-history/route.ts
git commit -m "feat: add watch history API route"
```

---

### Task 15: Build OAuth Callback Routes

**Files:**
- Create: `src/app/setup/callback/google/route.ts`
- Create: `src/app/setup/callback/onedrive/route.ts`

**Step 1: Implement Google OAuth callback**

Create `src/app/setup/callback/google/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCode } from "@/lib/cloud/google-drive";
import { saveConnection, getPairingSession } from "@/lib/kv";
import { v4 as uuid } from "uuid";
import type { CloudConnection } from "@/types";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state"); // contains pairing code

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/setup?error=missing_params", request.url)
    );
  }

  try {
    const pairingSession = await getPairingSession(state);
    if (!pairingSession) {
      return NextResponse.redirect(
        new URL("/setup?error=pairing_expired", request.url)
      );
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/setup/callback/google`;
    const tokens = await exchangeGoogleCode(code, redirectUri);

    const connection: CloudConnection = {
      id: uuid(),
      provider: "google",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiry: Date.now() + tokens.expiresIn * 1000,
      email: tokens.email,
      folders: [],
    };

    await saveConnection(pairingSession.sessionId, connection);

    // Redirect to setup page with success
    return NextResponse.redirect(
      new URL(
        `/setup?paired=${state}&connectionId=${connection.id}&provider=google`,
        request.url
      )
    );
  } catch (error) {
    console.error("Google OAuth callback error:", error);
    return NextResponse.redirect(
      new URL("/setup?error=oauth_failed", request.url)
    );
  }
}
```

**Step 2: Implement OneDrive OAuth callback**

Create `src/app/setup/callback/onedrive/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { exchangeOneDriveCode } from "@/lib/cloud/onedrive";
import { saveConnection, getPairingSession } from "@/lib/kv";
import { v4 as uuid } from "uuid";
import type { CloudConnection } from "@/types";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/setup?error=missing_params", request.url)
    );
  }

  try {
    const pairingSession = await getPairingSession(state);
    if (!pairingSession) {
      return NextResponse.redirect(
        new URL("/setup?error=pairing_expired", request.url)
      );
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/setup/callback/onedrive`;
    const tokens = await exchangeOneDriveCode(code, redirectUri);

    const connection: CloudConnection = {
      id: uuid(),
      provider: "onedrive",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiry: Date.now() + tokens.expiresIn * 1000,
      email: tokens.email,
      folders: [],
    };

    await saveConnection(pairingSession.sessionId, connection);

    return NextResponse.redirect(
      new URL(
        `/setup?paired=${state}&connectionId=${connection.id}&provider=onedrive`,
        request.url
      )
    );
  } catch (error) {
    console.error("OneDrive OAuth callback error:", error);
    return NextResponse.redirect(
      new URL("/setup?error=oauth_failed", request.url)
    );
  }
}
```

**Step 3: Commit**

```bash
git add src/app/setup/callback/
git commit -m "feat: add Google and OneDrive OAuth callback routes"
```

---

### Task 16: Build Browse API Route (list files for a connection/folder)

**Files:**
- Create: `src/app/api/browse/route.ts`

**Step 1: Implement browse endpoint**

Create `src/app/api/browse/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConnections } from "@/lib/kv";
import { listGoogleDriveFiles } from "@/lib/cloud/google-drive";
import { listOneDriveFiles } from "@/lib/cloud/onedrive";
import type { BrowseItem } from "@/types";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const connectionId = request.nextUrl.searchParams.get("connectionId");
  const folderId = request.nextUrl.searchParams.get("folderId");

  if (!sessionId) {
    return NextResponse.json(
      { error: "Missing sessionId" },
      { status: 400 }
    );
  }

  try {
    const connections = await getConnections(sessionId);

    if (connectionId && folderId) {
      // List files in a specific folder
      const connection = connections.find((c) => c.id === connectionId);
      if (!connection) {
        return NextResponse.json(
          { error: "Connection not found" },
          { status: 404 }
        );
      }

      let items: BrowseItem[];
      if (connection.provider === "google") {
        items = await listGoogleDriveFiles(sessionId, connection, folderId);
      } else {
        items = await listOneDriveFiles(sessionId, connection, folderId);
      }

      return NextResponse.json({ items });
    }

    // List all configured folders across all connections
    const allItems: Array<{
      connectionId: string;
      provider: string;
      email: string;
      folderName: string;
      items: BrowseItem[];
    }> = [];

    for (const conn of connections) {
      for (const folder of conn.folders) {
        let items: BrowseItem[];
        if (conn.provider === "google") {
          items = await listGoogleDriveFiles(sessionId, conn, folder.id);
        } else {
          items = await listOneDriveFiles(sessionId, conn, folder.id);
        }
        allItems.push({
          connectionId: conn.id,
          provider: conn.provider,
          email: conn.email,
          folderName: folder.name,
          items,
        });
      }
    }

    return NextResponse.json({ folders: allItems });
  } catch (error) {
    console.error("Browse error:", error);
    return NextResponse.json(
      { error: "Failed to browse files" },
      { status: 500 }
    );
  }
}
```

**Step 2: Commit**

```bash
git add src/app/api/browse/route.ts
git commit -m "feat: add browse API route for listing cloud files"
```

---

## Phase 4B: Setup & Pairing Pages

> Depends on Phase 2B, 2C, 2D

### Task 17: Build Setup Page (Phone/Computer)

**Files:**
- Create: `src/app/setup/page.tsx`
- Create: `src/app/setup/folder-picker.tsx`

**Step 1: Implement the setup page**

Create `src/app/setup/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CloudProvider } from "@/types";

interface ConnectionInfo {
  id: string;
  provider: CloudProvider;
  email: string;
  folders: Array<{ id: string; name: string }>;
}

export default function SetupPage() {
  const searchParams = useSearchParams();
  const pairingCode = searchParams.get("code");
  const pairedCode = searchParams.get("paired");
  const newConnectionId = searchParams.get("connectionId");
  const error = searchParams.get("error");

  const [code, setCode] = useState(pairingCode || "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [showFolderPicker, setShowFolderPicker] = useState<string | null>(null);

  // If we just came back from OAuth callback
  useEffect(() => {
    if (pairedCode && newConnectionId) {
      setCode(pairedCode);
      // Fetch the session to get connections
      fetch(`/api/pairing/status?code=${pairedCode}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.sessionId) {
            setSessionId(data.sessionId);
            setShowFolderPicker(newConnectionId);
          }
        });
    }
  }, [pairedCode, newConnectionId]);

  const connectGoogle = () => {
    const redirectUri = `${window.location.origin}/setup/callback/google`;
    const state = code;
    const params = new URLSearchParams({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      access_type: "offline",
      prompt: "consent",
      state,
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  };

  const connectOneDrive = () => {
    const redirectUri = `${window.location.origin}/setup/callback/onedrive`;
    const state = code;
    const params = new URLSearchParams({
      client_id: process.env.NEXT_PUBLIC_ONEDRIVE_CLIENT_ID || "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "Files.Read offline_access",
      state,
    });
    window.location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-2">TV Video Setup</h1>
      <p className="text-gray-600 mb-8">
        Connect your cloud storage to stream videos on your TV.
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
          {error === "pairing_expired"
            ? "Pairing code expired. Please get a new code from your TV."
            : error === "oauth_failed"
            ? "Failed to connect. Please try again."
            : `Error: ${error}`}
        </div>
      )}

      {!code && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
          <h2 className="text-xl font-semibold mb-3">Enter Pairing Code</h2>
          <p className="text-gray-500 mb-4">
            Enter the code shown on your TV screen.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).elements.namedItem(
                "code"
              ) as HTMLInputElement;
              setCode(input.value.trim());
            }}
          >
            <input
              name="code"
              type="text"
              placeholder="TV-000000"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-lg font-mono mb-4"
            />
            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
            >
              Connect
            </button>
          </form>
        </div>
      )}

      {code && !showFolderPicker && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-xl font-semibold mb-1">Pairing Code</h2>
            <p className="text-2xl font-mono font-bold text-blue-600 mb-4">
              {code}
            </p>

            <h3 className="text-lg font-semibold mb-3">
              Connect a Cloud Source
            </h3>

            <div className="space-y-3">
              <button
                onClick={connectGoogle}
                className="w-full flex items-center gap-3 bg-white border border-gray-300 rounded-lg px-4 py-3 hover:bg-gray-50 transition"
              >
                <svg className="w-6 h-6" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                <span className="font-medium">Connect Google Drive</span>
              </button>

              <button
                onClick={connectOneDrive}
                className="w-full flex items-center gap-3 bg-white border border-gray-300 rounded-lg px-4 py-3 hover:bg-gray-50 transition"
              >
                <svg className="w-6 h-6" viewBox="0 0 24 24">
                  <path
                    fill="#0078D4"
                    d="M10.457 6c.736 0 1.437.14 2.082.395A5.48 5.48 0 0118 4c3.038 0 5.5 2.462 5.5 5.5 0 .324-.029.64-.083.95A4.001 4.001 0 0120 18H6a4 4 0 01-.5-7.97A5.97 5.97 0 0110.457 6z"
                  />
                </svg>
                <span className="font-medium">Connect OneDrive</span>
              </button>
            </div>
          </div>

          {connections.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h3 className="text-lg font-semibold mb-3">
                Connected Sources
              </h3>
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                >
                  <div>
                    <span className="font-medium capitalize">
                      {conn.provider}
                    </span>
                    <span className="text-gray-500 ml-2">{conn.email}</span>
                  </div>
                  <span className="text-green-600 text-sm">Connected</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showFolderPicker && sessionId && (
        <FolderPicker
          sessionId={sessionId}
          connectionId={showFolderPicker}
          provider={
            (searchParams.get("provider") as CloudProvider) || "google"
          }
          onDone={() => {
            setShowFolderPicker(null);
            // Refresh connections list
          }}
        />
      )}
    </div>
  );
}

function FolderPicker({
  sessionId,
  connectionId,
  provider,
  onDone,
}: {
  sessionId: string;
  connectionId: string;
  provider: CloudProvider;
  onDone: () => void;
}) {
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [currentPath, setCurrentPath] = useState<
    Array<{ id: string; name: string }>
  >([{ id: "root", name: "Root" }]);
  const [selectedFolders, setSelectedFolders] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [loading, setLoading] = useState(true);

  const currentFolderId = currentPath[currentPath.length - 1].id;

  useEffect(() => {
    setLoading(true);
    fetch(
      `/api/setup/folders?sessionId=${sessionId}&connectionId=${connectionId}&folderId=${currentFolderId}`
    )
      .then((r) => r.json())
      .then((data) => {
        setFolders(data.folders ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId, connectionId, currentFolderId]);

  const selectFolder = (folder: { id: string; name: string }) => {
    setSelectedFolders((prev) => {
      const exists = prev.find((f) => f.id === folder.id);
      if (exists) return prev.filter((f) => f.id !== folder.id);
      return [...prev, folder];
    });
  };

  const saveAndFinish = async () => {
    await fetch("/api/setup/save-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        connectionId,
        folders: selectedFolders,
      }),
    });
    onDone();
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6">
      <h2 className="text-xl font-semibold mb-1">Select Folders</h2>
      <p className="text-gray-500 mb-4">
        Choose which folders to show on your TV.
      </p>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 mb-4 text-sm">
        {currentPath.map((segment, i) => (
          <span key={segment.id}>
            {i > 0 && <span className="text-gray-400 mx-1">/</span>}
            <button
              onClick={() => setCurrentPath(currentPath.slice(0, i + 1))}
              className="text-blue-600 hover:underline"
            >
              {segment.name}
            </button>
          </span>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center text-gray-500">Loading...</div>
      ) : (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {folders.map((folder) => (
            <div
              key={folder.id}
              className="flex items-center justify-between border border-gray-200 rounded-lg px-4 py-3"
            >
              <button
                onClick={() =>
                  setCurrentPath([...currentPath, folder])
                }
                className="flex items-center gap-2 text-left flex-1"
              >
                <span>📁</span>
                <span className="font-medium">{folder.name}</span>
              </button>
              <button
                onClick={() => selectFolder(folder)}
                className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
                  selectedFolders.find((f) => f.id === folder.id)
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {selectedFolders.find((f) => f.id === folder.id)
                  ? "Selected"
                  : "Select"}
              </button>
            </div>
          ))}
          {folders.length === 0 && (
            <p className="text-gray-500 py-4 text-center">
              No subfolders found.
            </p>
          )}
        </div>
      )}

      {selectedFolders.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          <p className="text-sm text-gray-600 mb-3">
            {selectedFolders.length} folder(s) selected:
            {selectedFolders.map((f) => f.name).join(", ")}
          </p>
          <button
            onClick={saveAndFinish}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
          >
            Save & Finish
          </button>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Create the setup API routes**

Create `src/app/api/setup/folders/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConnections } from "@/lib/kv";
import { listGoogleDriveFolders } from "@/lib/cloud/google-drive";
import { listOneDriveFolders } from "@/lib/cloud/onedrive";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const connectionId = request.nextUrl.searchParams.get("connectionId");
  const folderId = request.nextUrl.searchParams.get("folderId") || "root";

  if (!sessionId || !connectionId) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  try {
    const connections = await getConnections(sessionId);
    const connection = connections.find((c) => c.id === connectionId);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    let folders;
    if (connection.provider === "google") {
      folders = await listGoogleDriveFolders(connection.accessToken, folderId);
    } else {
      folders = await listOneDriveFolders(connection.accessToken, folderId);
    }

    return NextResponse.json({ folders });
  } catch (error) {
    console.error("Folder list error:", error);
    return NextResponse.json({ error: "Failed to list folders" }, { status: 500 });
  }
}
```

Create `src/app/api/setup/save-folders/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConnections, saveConnection } from "@/lib/kv";

export async function POST(request: NextRequest) {
  try {
    const { sessionId, connectionId, folders } = await request.json();

    if (!sessionId || !connectionId || !folders) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    const connections = await getConnections(sessionId);
    const connection = connections.find((c) => c.id === connectionId);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    connection.folders = folders.map((f: { id: string; name: string }) => ({
      id: f.id,
      name: f.name,
      provider: connection.provider,
      connectionId: connection.id,
    }));

    await saveConnection(sessionId, connection);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Save folders error:", error);
    return NextResponse.json({ error: "Failed to save folders" }, { status: 500 });
  }
}
```

**Step 3: Commit**

```bash
git add src/app/setup/ src/app/api/setup/
git commit -m "feat: add setup page with OAuth flow and folder picker"
```

---

## Phase 4C: Home Page (TV Browse UI)

> Depends on Phase 2A, 2B, Phase 3

### Task 18: Build TV Home Page

**Files:**
- Create: `src/app/page.tsx`
- Create: `src/app/tv-home.tsx`

**Step 1: Create the server component wrapper**

Replace `src/app/page.tsx` with:

```tsx
import { TVHome } from "./tv-home";

export default function HomePage() {
  return <TVHome />;
}
```

**Step 2: Create the TV home client component**

Create `src/app/tv-home.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { FocusProvider, useDpad } from "@/lib/navigation";
import { ContentRow } from "@/components/content-row";
import { POLL_INTERVAL_MS } from "@/lib/constants";
import type { BrowseItem, WatchHistory } from "@/types";

interface FolderGroup {
  connectionId: string;
  provider: string;
  email: string;
  folderName: string;
  items: BrowseItem[];
}

function TVHomeInner() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [watchHistories, setWatchHistories] = useState<Map<string, WatchHistory>>(new Map());

  // Check for existing session or create pairing
  useEffect(() => {
    const stored = localStorage.getItem("tv-session-id");
    if (stored) {
      setSessionId(stored);
      return;
    }

    // No session — create a pairing code
    fetch("/api/pairing", { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        setPairingCode(data.code);
        localStorage.setItem("tv-pairing-code", data.code);
        localStorage.setItem("tv-session-id-pending", data.sessionId);
      });
  }, []);

  // Poll for pairing completion
  useEffect(() => {
    if (!pairingCode || sessionId) return;

    const interval = setInterval(() => {
      fetch(`/api/pairing/status?code=${pairingCode}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.paired && data.sessionId) {
            localStorage.setItem("tv-session-id", data.sessionId);
            localStorage.removeItem("tv-pairing-code");
            localStorage.removeItem("tv-session-id-pending");
            setSessionId(data.sessionId);
            setPairingCode(null);
          }
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [pairingCode, sessionId]);

  // Fetch content when session is available
  useEffect(() => {
    if (!sessionId) return;

    setLoading(true);
    fetch(`/api/browse?sessionId=${sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        setFolders(data.folders ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId]);

  const handleVideoSelect = useCallback(
    (videoId: string, provider: string, connectionId: string) => {
      router.push(
        `/play/${videoId}?provider=${provider}&connectionId=${connectionId}&sessionId=${sessionId}`
      );
    },
    [router, sessionId]
  );

  const handleFolderSelect = useCallback(
    (folderId: string, provider: string, connectionId: string) => {
      router.push(
        `/folder/${folderId}?provider=${provider}&connectionId=${connectionId}&sessionId=${sessionId}`
      );
    },
    [router, sessionId]
  );

  useDpad();

  // Pairing screen
  if (pairingCode && !sessionId) {
    return (
      <div className="min-h-screen bg-tv-bg flex flex-col items-center justify-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <h1 className="text-tv-2xl font-bold mb-4">TV Video</h1>
          <p className="text-tv-lg text-tv-text-dim mb-8">
            Scan the QR code or visit the setup page
          </p>
          <div className="bg-white rounded-2xl p-8 mb-8 inline-block">
            {/* QR code will render here — using the pairing URL */}
            <div className="w-48 h-48 bg-gray-200 flex items-center justify-center text-gray-500">
              QR Code
            </div>
          </div>
          <p className="text-tv-xl font-mono font-bold text-tv-accent mb-4">
            {pairingCode}
          </p>
          <p className="text-tv-sm text-tv-text-dim">
            Enter this code at{" "}
            <span className="text-tv-text">
              {typeof window !== "undefined" ? window.location.origin : ""}/setup
            </span>
          </p>
          <div className="mt-8 flex items-center gap-2 text-tv-text-dim">
            <div className="w-3 h-3 rounded-full bg-tv-accent animate-pulse" />
            <span className="text-tv-xs">Waiting for connection...</span>
          </div>
        </motion.div>
      </div>
    );
  }

  // Loading screen
  if (loading) {
    return (
      <div className="min-h-screen bg-tv-bg flex items-center justify-center">
        <div className="text-tv-lg text-tv-text-dim">Loading...</div>
      </div>
    );
  }

  // No content
  if (folders.length === 0) {
    return (
      <div className="min-h-screen bg-tv-bg flex flex-col items-center justify-center">
        <h1 className="text-tv-xl font-bold mb-4">No Content</h1>
        <p className="text-tv-base text-tv-text-dim">
          Connect a cloud source from your phone to get started.
        </p>
      </div>
    );
  }

  // Main browse UI
  return (
    <div className="min-h-screen bg-tv-bg py-tv-padding overflow-y-auto">
      <motion.h1
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="text-tv-xl font-bold px-tv-padding mb-6"
      >
        TV Video
      </motion.h1>

      <AnimatePresence>
        {folders.map((group, rowIndex) => (
          <ContentRow
            key={`${group.connectionId}-${group.folderName}`}
            title={`${group.folderName} — ${group.email}`}
            items={group.items}
            rowIndex={rowIndex}
            watchHistories={watchHistories}
            onVideoSelect={handleVideoSelect}
            onFolderSelect={handleFolderSelect}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

export function TVHome() {
  return (
    <FocusProvider>
      <TVHomeInner />
    </FocusProvider>
  );
}
```

**Step 3: Commit**

```bash
git add src/app/page.tsx src/app/tv-home.tsx
git commit -m "feat: add TV home page with pairing screen and browse UI"
```

---

## Phase 4D: Folder View Page

> Depends on Phase 2A, Phase 3

### Task 19: Build Folder View Page

**Files:**
- Create: `src/app/folder/[folderId]/page.tsx`

**Step 1: Implement the folder view page**

Create `src/app/folder/[folderId]/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { FocusProvider, useDpad } from "@/lib/navigation";
import { ContentGrid } from "@/components/content-grid";
import { Breadcrumb } from "@/components/breadcrumb";
import type { BrowseItem } from "@/types";

function FolderViewInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const folderId = params.folderId as string;
  const provider = searchParams.get("provider") || "";
  const connectionId = searchParams.get("connectionId") || "";
  const sessionId = searchParams.get("sessionId") || "";
  const folderName = searchParams.get("name") || "Folder";

  const [items, setItems] = useState<BrowseItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(
      `/api/browse?sessionId=${sessionId}&connectionId=${connectionId}&folderId=${folderId}`
    )
      .then((r) => r.json())
      .then((data) => {
        setItems(data.items ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId, connectionId, folderId]);

  const handleVideoSelect = useCallback(
    (videoId: string, prov: string, connId: string) => {
      router.push(
        `/play/${videoId}?provider=${prov}&connectionId=${connId}&sessionId=${sessionId}`
      );
    },
    [router, sessionId]
  );

  const handleFolderSelect = useCallback(
    (fId: string, prov: string, connId: string) => {
      router.push(
        `/folder/${fId}?provider=${prov}&connectionId=${connId}&sessionId=${sessionId}`
      );
    },
    [router, sessionId]
  );

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleBreadcrumbNavigate = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router]
  );

  useDpad({ onBack: handleBack });

  const breadcrumbs = [
    { label: "Home", href: "/" },
    { label: folderName, href: "#" },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-tv-bg flex items-center justify-center">
        <div className="text-tv-lg text-tv-text-dim">Loading...</div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.25 }}
      className="min-h-screen bg-tv-bg py-tv-padding overflow-y-auto"
    >
      <Breadcrumb segments={breadcrumbs} onNavigate={handleBreadcrumbNavigate} />

      {items.length === 0 ? (
        <div className="flex items-center justify-center py-32">
          <p className="text-tv-lg text-tv-text-dim">This folder is empty</p>
        </div>
      ) : (
        <ContentGrid
          items={items}
          onVideoSelect={handleVideoSelect}
          onFolderSelect={handleFolderSelect}
        />
      )}
    </motion.div>
  );
}

export default function FolderPage() {
  return (
    <FocusProvider>
      <FolderViewInner />
    </FocusProvider>
  );
}
```

**Step 2: Commit**

```bash
git add src/app/folder/
git commit -m "feat: add folder view page with grid layout and breadcrumbs"
```

---

## Phase 4E: Video Player Page

> Depends on Phase 2A, 2B, Phase 4A (stream URL route)

### Task 20: Build Video Player Page

**Files:**
- Create: `src/app/play/[videoId]/page.tsx`
- Create: `src/components/tv-player.tsx`

**Step 1: Create the TV player component**

Create `src/components/tv-player.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";
import {
  CONTROLS_AUTO_HIDE_MS,
  SEEK_STEP_SECONDS,
  WATCH_HISTORY_SAVE_INTERVAL_MS,
} from "@/lib/constants";

interface TVPlayerProps {
  src: string;
  initialPosition?: number;
  onBack: () => void;
  onProgress?: (position: number, duration: number) => void;
}

export function TVPlayer({
  src,
  initialPosition = 0,
  onBack,
  onProgress,
}: TVPlayerProps) {
  const videoRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ReturnType<typeof videojs> | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Format time as HH:MM:SS or MM:SS
  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (playing) setShowControls(false);
    }, CONTROLS_AUTO_HIDE_MS);
  }, [playing]);

  // Initialize Video.js
  useEffect(() => {
    if (!videoRef.current) return;

    const videoElement = document.createElement("video-js");
    videoElement.classList.add("vjs-big-play-centered", "vjs-fill");
    videoRef.current.appendChild(videoElement);

    const player = videojs(videoElement, {
      controls: false, // We use custom controls
      autoplay: true,
      preload: "metadata",
      fluid: false,
      fill: true,
      sources: [{ src, type: "video/mp4" }],
      html5: {
        vhs: {
          overrideNative: false,
        },
        nativeVideoTracks: true,
        nativeAudioTracks: true,
      },
    });

    player.ready(() => {
      if (initialPosition > 0) {
        player.currentTime(initialPosition);
      }
    });

    player.on("play", () => setPlaying(true));
    player.on("pause", () => setPlaying(false));
    player.on("timeupdate", () => {
      setCurrentTime(player.currentTime() ?? 0);
      setDuration(player.duration() ?? 0);

      // Update buffered range
      const buffered = player.buffered();
      if (buffered && buffered.length > 0) {
        setBufferedEnd(buffered.end(buffered.length - 1));
      }
    });

    playerRef.current = player;

    return () => {
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [src, initialPosition]);

  // Save progress periodically
  useEffect(() => {
    saveTimerRef.current = setInterval(() => {
      if (playerRef.current && onProgress) {
        const time = playerRef.current.currentTime() ?? 0;
        const dur = playerRef.current.duration() ?? 0;
        if (dur > 0) onProgress(time, dur);
      }
    }, WATCH_HISTORY_SAVE_INTERVAL_MS);

    return () => {
      if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    };
  }, [onProgress]);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const player = playerRef.current;
      if (!player) return;

      resetHideTimer();

      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault();
          if (player.paused()) {
            player.play();
          } else {
            player.pause();
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          player.currentTime(
            Math.max(0, (player.currentTime() ?? 0) - SEEK_STEP_SECONDS)
          );
          break;
        case "ArrowRight":
          e.preventDefault();
          player.currentTime(
            Math.min(
              player.duration() ?? 0,
              (player.currentTime() ?? 0) + SEEK_STEP_SECONDS
            )
          );
          break;
        case "Escape":
        case "Backspace":
          e.preventDefault();
          // Save position before leaving
          if (onProgress) {
            onProgress(
              player.currentTime() ?? 0,
              player.duration() ?? 0
            );
          }
          onBack();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack, onProgress, resetHideTimer]);

  // Auto-hide controls
  useEffect(() => {
    resetHideTimer();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [resetHideTimer]);

  const togglePlayPause = () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused()) {
      player.play();
    } else {
      player.pause();
    }
    resetHideTimer();
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div
      className="fixed inset-0 bg-black z-50"
      onClick={togglePlayPause}
      onMouseMove={resetHideTimer}
    >
      {/* Video.js container */}
      <div ref={videoRef} className="w-full h-full" />

      {/* Custom TV Controls Overlay */}
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Back button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onBack();
          }}
          className="absolute top-8 left-8 text-white bg-white/10 backdrop-blur-sm rounded-full p-4 hover:bg-white/20 transition"
        >
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Center play/pause */}
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={(e) => {
              e.stopPropagation();
              togglePlayPause();
            }}
            className="text-white bg-white/10 backdrop-blur-sm rounded-full p-6 hover:bg-white/20 transition"
          >
            {playing ? (
              <svg className="w-20 h-20" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg className="w-20 h-20" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        </div>

        {/* Bottom controls bar */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-8 pb-8 pt-16">
          {/* Seek bar */}
          <div className="relative w-full h-5 mb-4 group cursor-pointer">
            {/* Track background */}
            <div className="absolute inset-0 rounded-full bg-white/20" />
            {/* Buffered range */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              style={{ width: `${bufferedPercent}%` }}
            />
            {/* Progress */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-tv-accent"
              style={{ width: `${progressPercent}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white shadow-lg"
              style={{ left: `calc(${progressPercent}% - 12px)` }}
            />
          </div>

          {/* Time display */}
          <div className="flex justify-between text-white text-tv-sm font-mono">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Create the player page**

Create `src/app/play/[videoId]/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { TVPlayer } from "@/components/tv-player";

export default function PlayPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const videoId = params.videoId as string;
  const provider = searchParams.get("provider") || "";
  const connectionId = searchParams.get("connectionId") || "";
  const sessionId = searchParams.get("sessionId") || "";

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [initialPosition, setInitialPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Fetch stream URL and watch history
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch stream URL and watch history in parallel
        const [streamRes, historyRes] = await Promise.all([
          fetch(
            `/api/stream-url?fileId=${videoId}&provider=${provider}&connectionId=${connectionId}&sessionId=${sessionId}`
          ),
          fetch(
            `/api/watch-history?sessionId=${sessionId}&fileId=${videoId}`
          ),
        ]);

        if (!streamRes.ok) throw new Error("Failed to get stream URL");
        const streamData = await streamRes.json();
        setStreamUrl(streamData.url);

        if (historyRes.ok) {
          const historyData = await historyRes.json();
          if (historyData.history?.position) {
            setInitialPosition(historyData.history.position);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    };

    fetchData();
  }, [videoId, provider, connectionId, sessionId]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleProgress = useCallback(
    (position: number, duration: number) => {
      fetch("/api/watch-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          fileId: videoId,
          provider,
          position,
          duration,
        }),
      }).catch(() => {
        // Best-effort save
      });
    },
    [sessionId, videoId, provider]
  );

  if (error) {
    return (
      <div className="min-h-screen bg-tv-bg flex flex-col items-center justify-center">
        <p className="text-tv-lg text-tv-warning mb-4">
          Failed to load video
        </p>
        <p className="text-tv-sm text-tv-text-dim">{error}</p>
      </div>
    );
  }

  if (!streamUrl) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="min-h-screen bg-black flex items-center justify-center"
      >
        <div className="text-tv-lg text-white">Loading video...</div>
      </motion.div>
    );
  }

  return (
    <TVPlayer
      src={streamUrl}
      initialPosition={initialPosition}
      onBack={handleBack}
      onProgress={handleProgress}
    />
  );
}
```

**Step 3: Commit**

```bash
git add src/components/tv-player.tsx src/app/play/
git commit -m "feat: add TV video player with custom controls and resume"
```

---

## Phase 5: Polish & Integration

### Task 21: Add Environment Validation & Error Boundary

**Files:**
- Create: `src/lib/env.ts`
- Create: `src/components/error-boundary.tsx`

**Step 1: Create environment validation**

Create `src/lib/env.ts`:

```ts
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
```

**Step 2: Create error boundary**

Create `src/components/error-boundary.tsx`:

```tsx
"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="min-h-screen bg-tv-bg flex flex-col items-center justify-center">
            <h1 className="text-tv-xl font-bold mb-4">Something went wrong</h1>
            <p className="text-tv-base text-tv-text-dim mb-8">
              {this.state.error?.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-tv-accent text-white px-8 py-3 rounded-lg text-tv-base"
            >
              Reload
            </button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
```

**Step 3: Commit**

```bash
git add src/lib/env.ts src/components/error-boundary.tsx
git commit -m "feat: add environment validation and error boundary"
```

---

### Task 22: Add next.config.js and Vercel Configuration

**Files:**
- Create/Modify: `next.config.ts` (or `.js` depending on scaffold)
- Create: `vercel.json`

**Step 1: Configure Next.js**

Update `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "*.bing.net",
      },
      {
        protocol: "https",
        hostname: "*.live.com",
      },
    ],
  },
  // Optimize for TV browsers
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
};

export default nextConfig;
```

**Step 2: Commit**

```bash
git add next.config.ts
git commit -m "feat: configure Next.js for cloud image domains and production"
```

---

## Summary of All Tasks

| Phase | Task | Description | Depends On |
|-------|------|-------------|------------|
| 1 | 1 | Initialize Next.js project | - |
| 1 | 2 | Configure Tailwind TV theme | 1 |
| 1 | 3 | Directory structure & types | 1 |
| 2A | 4 | D-pad navigation system | 1-3 |
| 2B | 5 | Vercel KV storage helpers | 1-3 |
| 2C | 6 | Google Drive API client | 1-3 |
| 2D | 7 | OneDrive API client | 1-3 |
| 3 | 8 | VideoCard component | 4 |
| 3 | 9 | FolderCard component | 4 |
| 3 | 10 | ContentRow component | 8, 9 |
| 3 | 11 | ContentGrid & Breadcrumb | 8, 9 |
| 4A | 12 | Stream URL API route | 5, 6, 7 |
| 4A | 13 | Pairing & status API routes | 5 |
| 4A | 14 | Watch history API route | 5 |
| 4A | 15 | OAuth callback routes | 5, 6, 7 |
| 4A | 16 | Browse API route | 5, 6, 7 |
| 4B | 17 | Setup page (phone/computer) | 13, 15 |
| 4C | 18 | TV Home page | 4, 10, 13 |
| 4D | 19 | Folder view page | 4, 11, 16 |
| 4E | 20 | Video player page | 4, 12, 14 |
| 5 | 21 | Error boundary & env validation | 1-3 |
| 5 | 22 | Next.js & Vercel config | 1 |

**Parallel execution groups after Phase 1:**
- **Group A:** Tasks 4, 5, 6, 7 (all in parallel)
- **Group B:** Tasks 8, 9, 12, 13, 14, 15, 16 (after Group A completes)
- **Group C:** Tasks 10, 11, 17, 18, 19, 20, 21, 22 (after their deps in Group B)
