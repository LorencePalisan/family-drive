import { MaterialIcons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fileKind, formatBytes, KIND_LABEL } from "@shared/format";
import type { DriveFile } from "@shared/types";
import { FileActions } from "@/components/FileActions";
import { FileIcon } from "@/components/FileIcon";
import { api, contentSource, thumbnailSource } from "@/lib/api";
import { downloadAndShare } from "@/lib/open";
import { useFile } from "@/lib/queries";

const FG = "#e3e3e3";

function Video({ file }: { file: DriveFile }) {
  const player = useVideoPlayer(contentSource(file), (p) => p.play());
  return <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls />;
}

function Photo({ file }: { file: DriveFile }) {
  const [loading, setLoading] = useState(true);
  return (
    <>
      <Image
        source={contentSource(file)}
        placeholder={file.hasThumbnail ? thumbnailSource(file) : undefined}
        placeholderContentFit="contain"
        contentFit="contain"
        style={StyleSheet.absoluteFill}
        onLoadEnd={() => setLoading(false)}
        cachePolicy="disk"
      />
      {loading ? <ActivityIndicator style={styles.spinner} color={FG} /> : null}
    </>
  );
}

function NoPreview({ file }: { file: DriveFile }) {
  const [busy, setBusy] = useState(false);
  return (
    <View style={styles.noPreview}>
      {file.hasThumbnail ? <Image source={thumbnailSource(file)} style={styles.bigThumb} contentFit="contain" /> : <FileIcon file={file} size={72} />}
      <Text style={styles.noPreviewTitle}>{file.name}</Text>
      <Text style={styles.noPreviewSub}>
        {KIND_LABEL[fileKind(file)]} · {formatBytes(file.size)}
      </Text>
      <Pressable
        disabled={busy}
        onPress={() => {
          setBusy(true);
          downloadAndShare(file)
            .catch((err: Error) => Alert.alert("Couldn't open the file", err.message))
            .finally(() => setBusy(false));
        }}
        style={styles.openButton}
      >
        {busy ? <ActivityIndicator color="#05302a" /> : <Text style={styles.openLabel}>Open with…</Text>}
      </Pressable>
    </View>
  );
}

export default function FileViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: file, error } = useFile(id);
  const [menu, setMenu] = useState(false);
  const kind = file && fileKind(file);

  useEffect(() => {
    api(`/files/${id}/opened`, { method: "POST" }).catch(() => {});
  }, [id]);

  return (
    <View style={styles.root}>
      <View style={styles.stage}>
        {!file ? (
          error ? <Text style={styles.noPreviewSub}>{error.message}</Text> : <ActivityIndicator color={FG} />
        ) : kind === "image" ? (
          <Photo file={file} />
        ) : kind === "video" ? (
          <Video file={file} />
        ) : (
          <NoPreview file={file} />
        )}
      </View>
      <SafeAreaView edges={["top"]} style={styles.topBar} pointerEvents="box-none">
        <View style={styles.topRow}>
          <Pressable hitSlop={8} onPress={() => router.back()} style={styles.iconButton} accessibilityLabel="Back">
            <MaterialIcons name="arrow-back" size={24} color={FG} />
          </Pressable>
          <Text numberOfLines={1} style={styles.title}>
            {file?.name ?? ""}
          </Text>
          {file ? (
            <>
              <Pressable hitSlop={8} onPress={() => downloadAndShare(file).catch((e: Error) => Alert.alert("Couldn't share", e.message))} style={styles.iconButton} accessibilityLabel="Share">
                <MaterialIcons name="share" size={22} color={FG} />
              </Pressable>
              <Pressable hitSlop={8} onPress={() => setMenu(true)} style={styles.iconButton} accessibilityLabel="More">
                <MaterialIcons name="more-vert" size={24} color={FG} />
              </Pressable>
            </>
          ) : null}
        </View>
      </SafeAreaView>
      <FileActions
        file={menu ? (file ?? null) : null}
        onClose={() => setMenu(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  spinner: { position: "absolute" },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: "#00000080" },
  topRow: { flexDirection: "row", alignItems: "center", height: 56, paddingHorizontal: 4 },
  iconButton: { padding: 12 },
  title: { flex: 1, color: FG, fontSize: 17 },
  noPreview: { alignItems: "center", gap: 10, padding: 32 },
  bigThumb: { width: 200, height: 200, borderRadius: 8 },
  noPreviewTitle: { color: FG, fontSize: 18, textAlign: "center", marginTop: 8 },
  noPreviewSub: { color: "#9aa0a6", fontSize: 14 },
  openButton: { marginTop: 16, backgroundColor: "#7dd3c0", height: 44, borderRadius: 22, paddingHorizontal: 24, alignItems: "center", justifyContent: "center", minWidth: 140 },
  openLabel: { color: "#05302a", fontSize: 15, fontWeight: "600" },
});
