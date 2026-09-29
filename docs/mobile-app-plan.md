# Family Drive — Mobile App Plan (iOS & Android)

_Drafted 2026-09-29. Status: planning; nothing built yet. **Platform decided: React Native with Expo** (2026-09-29)._

## Goal

Native iOS and Android apps for Family Drive (drive.lorencepalisan.com). The apps browse, view, upload and share the
family's files, and **automatically back up each phone's camera roll** at original resolution to the existing
Cloudflare backend (Worker + R2 + D1).

## Platform decision: React Native with Expo

**Decided: React Native + Expo (development builds, EAS).**

- **Reuses the current stack.** The web app is React 19 + TypeScript + TanStack Query, so the API client, shared types
  (`DriveFile`, `Me`, …), query hooks and formatting helpers carry over. Only the UI is rebuilt with native components.
- **One codebase** covers both iOS and Android.
- **Maintained modules exist for the features a family drive needs:**
  - `expo-media-library`: read the photo library and get the original files.
  - `expo-background-task`: scheduled background checks for new photos.
  - `expo-file-system`: background upload sessions that the OS finishes even after the app closes.
  - `expo-video`: video playback with seeking. The server already supports HTTP range requests.
  - `expo-notifications`: push notifications.
  - `expo-secure-store`: store the session token securely.
  - Native Google sign-in, and a share-sheet target ("Share to Family Drive").
- **Cloud builds.** EAS Build compiles in the cloud. A paid Apple account is needed for cloud iOS builds.
- **Build type.** Use an Expo **development build**, not Expo Go. If any gap appears, add a small native module without leaving Expo.

### Alternatives considered (not chosen)

| Option | Verdict |
|---|---|
| **Capacitor** (wrap the web app) | Fastest to ship (~1 week). Weak background upload and camera-roll backup; feels like a website in a frame. |
| **Flutter** | Excellent, but a new language (Dart) and no code shared with the web app. |
| **Native Swift + Kotlin** | Best possible result, but two separate apps to build and maintain. Too much for a family project. |
| **PWA** | Nearly free, but iOS limits background work and photo access, so no auto-backup. |

## Auto-backup: what's realistic

The limits below come from iOS and Android themselves. A native Swift or Kotlin app would face the same ones.

### Android: works well

- **Periodic scans** for new photos, no more often than every 15 minutes (set by WorkManager).
- **Large backlogs** (a first backup of thousands of photos) run as a visible foreground job with a progress notification.
- **Aggressive phone brands.** Xiaomi, Oppo, Vivo, Realme and Huawei may kill background work; users may need to turn off battery optimization.
- **Partial photo access.** On Android 14+, users can grant access to only some photos; auto-backup needs full access.

### iOS: works, but only when iOS allows it

- **No constant running.** iOS never lets an app run continuously in the background, and doesn't tell apps when a new photo is taken.
- **When backup actually happens:**
  - **App open:** every launch scans for new photos and starts uploading. This is the most reliable path.
  - **Uploads continue after closing.** Once started, iOS finishes them even if the app is closed or the phone is locked.
  - **Scheduled checks:** iOS runs these a few times a day at moments it chooses, most often overnight while charging on Wi-Fi.
- **iCloud "Optimize iPhone Storage".** The original may exist only in iCloud; the app must download it first (slower, uses data).
- Google Photos, Dropbox and OneDrive live with the same constraints on iPhone.

### What to tell the family

- **Android:** "New photos back up automatically, usually within 15 minutes to a few hours."
- **iPhone:** "Photos back up whenever you open the app, and usually overnight while charging. Opening it once a day keeps everything current."

## iOS distribution and cost

### Free: Apple ID + Xcode on the Mac

- **Setup:** install onto your own iPhone over USB with `npx expo run:ios --device`.
- **The app stops launching after 7 days** and must be reinstalled from Xcode. Data on the server is unaffected.
- **Other limits:**
  - At most 3 free-signed apps per device.
  - **No push notifications.**
  - **Share extension probably unavailable.** It needs a capability Apple generally reserves for paid accounts.
  - Each family iPhone would have to be plugged into the Mac and re-signed weekly.
- **What still works:** sign-in, browsing, viewing, uploading, and backup on app open, including background upload sessions.
- **Re-signing tools.** AltStore and SideStore re-sign weekly using your Apple ID; they're third-party and need your Apple ID login. A stopgap, not a family solution.

### Paid: Apple Developer Program, $99/year

- **Install period:** a year, not 7 days. TestFlight builds last 90 days and update over the air.
- **Push notifications and the share extension** work.
- **Family distribution:** TestFlight (up to 100 internal testers) or an unlisted App Store app. Nobody plugs into the Mac.
- **Cloud builds:** EAS cloud builds for iOS become available.

**Plan:** develop and test for free on your own iPhone, then pay the $99 when it's time to hand the app to the family.

## Android: points to plan around (no hard blockers)

| # | Item | Impact | Action |
|---|---|---|---|
| 1 | **Sideloading verification.** Google is requiring sideloaded apps on certified devices to come from verified developers (rollout in some countries from late 2026, globally in 2027). A free hobbyist tier and USB installs were announced. | Check before release | Confirm Google's current rules before relying on sideloading. |
| 2 | **Google Play internal testing.** $25 one-time plus an ID check. Up to 100 testers, no public listing, auto-updates. The 12-testers-for-14-days rule applies only to a public production listing. | Low | Use the internal testing track for family distribution. |
| 3 | **Google sign-in fingerprints.** The Android OAuth client needs the SHA-1 of every signing key: debug, release, and the Play App Signing key. | Setup trap | Register all fingerprints up front. |
| 4 | **Photo permissions.** Android 13+ asks separately for photos and videos; Android 14+ allows partial access. Play policy requires a declaration form for full-library access (backup apps qualify). | Medium | Detect partial access and explain; fill in the Play declaration. |
| 5 | **Photo location stripped.** Android removes GPS EXIF from photos handed to apps unless the app holds `ACCESS_MEDIA_LOCATION`. | **High: silent data loss** | Request it from day one. |
| 6 | **Background limits.** Android 14+ requires a declared foreground service type. Android 15 caps `dataSync` foreground services at 6 hours per 24 h. | Medium | Use "user-initiated data transfer" jobs (Android 14+) for large backups; may need a small native module. |
| 7 | **Aggressive phone brands.** Some brands kill background work. | Medium | One-time guided prompt to turn off battery optimization. |
| 8 | **D1 usage.** Six phones checking for new photos add up. | Medium | Use the fingerprint-based sync endpoint (below). |

## Backend changes required

1. **Native login and Bearer tokens**
   - Add `POST /api/auth/google/native`: verify the Google ID token obtained on the device, apply the same invite-only rules
     as the web callback, and return a session token.
   - Update `loadUser` (`src/worker/lib/session.ts`) to accept `Authorization: Bearer <token>` in addition to the `sid` cookie.
   - The app stores the token in `expo-secure-store`.
2. **Backup sync endpoint** (critical for D1 costs)
   - The phone sends a batch of photo fingerprints (for example the media-library asset ID plus size and creation time,
     or a content hash). The server answers with the ones it doesn't have yet.
   - A "changes since cursor" endpoint lets the app refresh cheaply instead of re-listing folders.
   - Background checks must never list the whole drive. Before the 2026-09-28 optimization, whole-drive queries pushed D1
     past the free tier's 5M rows read per day.
3. **Push notifications**
   - Add a `push_tokens` table (user, token, platform, updated_at).
   - Send through the Expo push service wherever `notify()` already runs: shares, files added to your folder, Google save-back.
4. **Uploads: mostly unchanged**
   - The existing 50 MB multipart flow (`POST /uploads`, `PUT /uploads/:id/parts/:n`, `POST /uploads/:id/complete`) suits
     mobile and background upload sessions.
   - Add a per-user "Camera backup" destination folder, created automatically.

## Proposed repository layout

```
apps/
  web/        # current React + Vite SPA
  mobile/     # Expo app
packages/
  shared/     # API client, types, formatting helpers, query keys
src/worker/   # Hono Worker (unchanged location, or moved to apps/api)
```

## Phases

| Phase | Scope | Estimate |
|---|---|---|
| **1. Foundation** | Monorepo split; `packages/shared`; native Google sign-in endpoint; Bearer-token sessions | ~1 week |
| **2. Core app** | Sign-in, browse folders, photo/video viewer, search, upload from the picker, share with family | ~2–3 weeks |
| **3. Backup & polish** | Camera-roll auto-backup (sync endpoint, background tasks and uploads), share-sheet target, push notifications, offline thumbnail cache, battery-optimization guidance | ~2 weeks |
| **4. Distribution** | iOS: TestFlight / unlisted App Store (paid account). Android: Play internal testing or sideloaded APK. | — |

**First milestone (free):** a proof of concept on the owner's iPhone via Xcode. Sign in, then back up the latest
10 photos, confirming background upload and original resolution (including location data) end to end.

## Open decisions

- [x] Mobile platform: **React Native with Expo** (decided 2026-09-29). Camera-roll auto-backup stays in scope.
- [ ] Pay $99/year for Apple distribution, and when?
- [ ] Android distribution: Play internal testing ($25) or sideloaded APK?
- [ ] Which phone brands and Android versions does the family use? (Affects background-work handling.)
- [ ] Back up videos automatically too, or photos only (and videos on Wi-Fi only)?
