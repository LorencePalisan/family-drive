import { MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatBytes } from "@shared/format";
import { Avatar } from "@/components/Avatar";
import { useAuth } from "@/lib/auth";
import { API_URL } from "@/lib/config";
import { useMe } from "@/lib/queries";
import { useColors } from "@/lib/theme";

export default function Account() {
  const c = useColors();
  const { signOut } = useAuth();
  const { data: me } = useMe();
  const pct = me ? Math.min(100, (me.storageUsed / me.storageQuota) * 100) : 0;

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.body}>
      {me ? (
        <View style={styles.profile}>
          <Avatar name={me.name} src={me.avatarUrl} size={72} />
          <Text style={[styles.name, { color: c.text }]}>{me.name}</Text>
          <Text style={{ color: c.text2 }}>{me.email}</Text>
        </View>
      ) : null}

      {me ? (
        <View style={[styles.card, { backgroundColor: c.surface }]}>
          <View style={styles.cardRow}>
            <MaterialIcons name="cloud-queue" size={22} color={c.text2} />
            <Text style={[styles.cardTitle, { color: c.text }]}>Storage</Text>
          </View>
          <View style={[styles.track, { backgroundColor: c.surface2 }]}>
            <View style={[styles.fill, { width: `${pct}%`, backgroundColor: pct > 90 ? c.danger : c.primary }]} />
          </View>
          <Text style={{ color: c.text2 }}>
            {formatBytes(me.storageUsed)} of {formatBytes(me.storageQuota)} used
          </Text>
        </View>
      ) : null}

      <View style={[styles.card, { backgroundColor: c.surface, paddingVertical: 4 }]}>
        <Pressable style={styles.item} android_ripple={{ color: c.selected }} onPress={() => router.push("/trash")}>
          <MaterialIcons name="delete-outline" size={22} color={c.text2} />
          <Text style={[styles.itemLabel, { color: c.text }]}>Trash</Text>
        </Pressable>
        <Pressable
          style={styles.item}
          android_ripple={{ color: c.selected }}
          onPress={() =>
            Alert.alert("Sign out?", "Uploads in progress will stop.", [
              { text: "Cancel", style: "cancel" },
              { text: "Sign out", style: "destructive", onPress: () => void signOut() },
            ])
          }
        >
          <MaterialIcons name="logout" size={22} color={c.danger} />
          <Text style={[styles.itemLabel, { color: c.danger }]}>Sign out</Text>
        </Pressable>
      </View>

      <Text style={[styles.footer, { color: c.text3 }]}>
        Family Drive {Constants.expoConfig?.version} · {API_URL.replace(/^https?:\/\//, "")}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  profile: { alignItems: "center", gap: 4, paddingVertical: 16 },
  name: { fontSize: 22, marginTop: 8 },
  card: { borderRadius: 16, padding: 16, gap: 12, overflow: "hidden" },
  cardRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardTitle: { fontSize: 16, fontWeight: "500" },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6 },
  item: { flexDirection: "row", alignItems: "center", gap: 16, height: 52, paddingHorizontal: 4 },
  itemLabel: { fontSize: 16 },
  footer: { textAlign: "center", fontSize: 12, marginTop: 8 },
});
