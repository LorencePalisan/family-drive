# Family Drive — Android app (Expo)

React Native + Expo (SDK 57, Expo Router) client for drive.lorencepalisan.com. Android first; iOS comes later.
The plan is in [`../docs/mobile-app-plan.md`](../docs/mobile-app-plan.md).

## What works

- Google sign-in (native, Credential Manager). The worker swaps the Google ID token for a 180-day Bearer session
  (`POST /api/auth/google/native`).
- Home (suggested folders + recent files), Starred, Shared with me, My Files, folders, Trash, Search with type filters.
- Photo viewer and video player (streams with range requests), "Share / Open with…" for everything else.
- Upload photos & videos (original quality), take a photo, upload any file, new folder. Uses the same 50 MB multipart
  flow as the web app and uploads a webp thumbnail.
- Star, rename, move to trash, restore.

Not yet: camera-roll auto-backup, push notifications, share-sheet target, sharing with family members (Phase 3).

## One-time Google Cloud setup (required for sign-in)

Native Google sign-in on Android only works if Google knows the app's signing key. In the **same Google Cloud project**
as the web OAuth client:

1. **APIs & Services → Credentials → Create credentials → OAuth client ID → Android.**
2. Package name: `com.lorencepalisan.familydrive`.
3. SHA-1 fingerprint — add one Android client per signing key:
   - **Local debug builds** (`npx expo run:android`): the React Native debug keystore,
     `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
   - **EAS builds**: run `npx eas-cli@latest credentials -p android` and copy the SHA-1 it shows.
   - **Google Play** (later): the "App signing key certificate" SHA-1 from Play Console → App integrity.

No secrets go into the app: it passes the *web* client ID (`src/lib/config.ts`), and the worker checks the token's
audience against `GOOGLE_CLIENT_ID`.

## Run it

Expo Go can't run this app (it uses native modules), so build a development client once:

```sh
cd mobile
npm install

# Option A — build on this Mac (needs Android Studio + an emulator or a USB-connected phone)
npx expo run:android

# Option B — build in the cloud (no Android Studio), then install the APK on your phone
npx eas-cli@latest login
npx eas-cli@latest build --platform android --profile development
npx expo start            # then open the installed dev client
```

Installable test build for the family (no dev server needed): `npm run build:apk` (EAS `preview` profile).

### Against a local worker

`npm run dev` at the repo root, then create `mobile/.env.local` with `EXPO_PUBLIC_API_URL=http://10.0.2.2:5173`
(the emulator's alias for your Mac). Dev builds show a **session token** box on the sign-in screen, so you can use a
seeded local token like `devtoken-owner-123` without Google.

## Checks

```sh
npm run typecheck
npm run lint
npx expo-doctor   # reports react 19.3 in ../node_modules (the web app's copy); Metro only resolves ./node_modules, so it's harmless
```

## Layout

```
src/app/          screens (Expo Router): (tabs)/ home, starred, shared, files · folder/[id] · file/[id] · search · account · trash · sign-in
src/components/   FileList, FileActions, Sheet (bottom sheet + prompt), UploadControls (New button + progress), …
src/lib/          api (Bearer token in SecureStore), auth, queries (TanStack Query), upload queue, pickers, theme
../shared/        types and formatting helpers shared with the web app
```
