/**
 * Server and Google sign-in settings. Override with EXPO_PUBLIC_* variables in mobile/.env.local, e.g. to point the
 * Android emulator at a local `npm run dev` worker: EXPO_PUBLIC_API_URL=http://10.0.2.2:5173
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "https://drive.lorencepalisan.com").replace(/\/$/, "");

/** The *web* OAuth client ID: Google puts it in the ID token's audience, and the worker checks it against GOOGLE_CLIENT_ID. */
export const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "1093087843629-keh8unqavfqk3udj0mcejrn9v4e7n6vv.apps.googleusercontent.com";
