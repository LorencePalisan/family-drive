import { View } from "react-native";
import { FileList } from "@/components/FileList";
import { DriveBottom } from "@/components/UploadControls";
import { useView } from "@/lib/queries";

export default function Shared() {
  const q = useView("shared");
  return (
    <View style={{ flex: 1 }}>
      <FileList
        items={q.data}
        loading={q.isPending}
        error={q.error}
        refreshing={q.isRefetching}
        onRefresh={() => q.refetch()}
        empty={{ icon: "people-outline", title: "Nothing shared with you yet", body: "Files and folders your family shares with you show up here." }}
      />
      <DriveBottom parentId={null} inTabs canAdd={false} />
    </View>
  );
}
