import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Logo } from "@/components/Logo";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { API_URL } from "@/lib/config";
import { useColors } from "@/lib/theme";

export default function SignIn() {
  const c = useColors();
  const { signIn, signInWithToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devToken, setDevToken] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "not_invited"
          ? `${err.message}. Ask the drive owner to invite you, then try again.`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={styles.center}>
        <Logo size={96} />
        <Text style={[styles.title, { color: c.text }]}>Family Drive</Text>
        <Text style={[styles.body, { color: c.text2 }]}>Your family’s photos, videos and files, in one private place.</Text>

        <Pressable
          disabled={busy}
          onPress={() => run(signIn)}
          android_ripple={{ color: c.selected }}
          style={[styles.button, { backgroundColor: c.primary, opacity: busy ? 0.6 : 1 }]}
        >
          {busy ? <ActivityIndicator color={c.onPrimary} /> : <Text style={[styles.buttonLabel, { color: c.onPrimary }]}>Sign in with Google</Text>}
        </Pressable>
        {error ? <Text style={[styles.error, { color: c.danger }]}>{error}</Text> : null}
      </View>

      {__DEV__ ? (
        <View style={styles.dev}>
          <Text style={[styles.devLabel, { color: c.text3 }]}>Dev: {API_URL}</Text>
          <View style={styles.devRow}>
            <TextInput
              value={devToken}
              onChangeText={setDevToken}
              placeholder="Session token (e.g. devtoken-owner-123)"
              placeholderTextColor={c.text3}
              autoCapitalize="none"
              style={[styles.devInput, { color: c.text, borderColor: c.border }]}
            />
            <Pressable disabled={!devToken || busy} onPress={() => run(() => signInWithToken(devToken.trim()))} style={styles.devButton}>
              <Text style={{ color: c.primary, fontWeight: "600" }}>Use</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  title: { fontSize: 28, fontWeight: "500", marginTop: 8 },
  body: { fontSize: 16, textAlign: "center", marginBottom: 24 },
  button: { height: 48, borderRadius: 24, paddingHorizontal: 28, minWidth: 220, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  error: { fontSize: 14, textAlign: "center", marginTop: 8 },
  dev: { padding: 16, gap: 6 },
  devLabel: { fontSize: 12 },
  devRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  devInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  devButton: { padding: 8 },
});
