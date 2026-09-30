import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { UploadSource } from "./upload";

const extFor = (mime?: string | null) => (mime ? `.${mime.split("/")[1]?.replace("jpeg", "jpg") ?? "bin"}` : "");

function fromAsset(a: ImagePicker.ImagePickerAsset): UploadSource {
  const size = a.fileSize ?? new File(a.uri).size;
  return {
    uri: a.uri,
    name: a.fileName ?? `${a.type === "video" ? "VID" : "IMG"}_${Date.now()}${extFor(a.mimeType)}`,
    size,
    mime: a.mimeType ?? undefined,
    width: a.width || undefined,
    height: a.height || undefined,
    duration: a.duration ? a.duration / 1000 : undefined,
  };
}

/** Photos and videos from the gallery, at original quality. */
export async function pickMedia(): Promise<UploadSource[]> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], allowsMultipleSelection: true, quality: 1 });
  return res.canceled ? [] : res.assets.map(fromAsset);
}

export async function takePhoto(): Promise<UploadSource[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Camera permission is needed to take a photo");
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
  return res.canceled ? [] : res.assets.map(fromAsset);
}

/** Any file from the system file picker (documents, downloads, etc.). */
export async function pickFiles(): Promise<UploadSource[]> {
  const res = await File.pickFileAsync({ multipleFiles: true });
  if (res.canceled) return [];
  return res.result.map((f) => ({ uri: f.uri, name: f.name, size: f.size, mime: f.type || undefined }));
}
