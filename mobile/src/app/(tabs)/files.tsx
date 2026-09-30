import { View } from "react-native";
import { FileList } from "@/components/FileList";
import { DriveBottom } from "@/components/UploadControls";
import { useView } from "@/lib/queries";

export default function MyFiles() {
  const q = useView("my");
  return (
    <View style={{ flex: 1 }}>
      <FileList
        items={q.data}
        loading={q.isPending}
        error={q.error}
        refreshing={q.isRefetching}
        onRefresh={() => q.refetch()}
        empty={{ icon: "folder-open", title: "Your files live here", body: "Tap New to upload or create a folder." }}
      />
      <DriveBottom parentId={null} inTabs />
    </View>
  );
}
