import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { DriveFile } from "@shared/types";
import { authHeaders } from "./api";
import { API_URL } from "./config";

/** Download a file into the cache (named after the original) and hand it to Android's share / open-with sheet. */
export async function downloadAndShare(f: DriveFile) {
  const dir = new Directory(Paths.cache, "shared", f.id);
  if (!dir.exists) dir.create({ intermediates: true });
  const dest = new File(dir, f.name);
  if (!dest.exists || dest.size !== f.size) {
    await File.downloadFileAsync(`${API_URL}/api/files/${f.id}/content?download=1`, dest, { headers: authHeaders(), idempotent: true });
  }
  await Sharing.shareAsync(dest.uri, { mimeType: f.mime ?? undefined, dialogTitle: f.name });
}
