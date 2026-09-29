/**
 * Feature switches. Google Drive sync is hidden for now; to bring it back, set this to true together with
 * GSYNC_ENABLED in src/worker/lib/gsync.ts and re-add the "* * * * *" cron in wrangler.jsonc.
 */
export const GOOGLE_SYNC_ENABLED = false;
