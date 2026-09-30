import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GoogleOneTapSignIn, isCancelledResponse, isNoSavedCredentialFoundResponse, isSuccessResponse } from "react-native-nitro-google-signin";
import { api, loadToken, saveToken, setUnauthorizedHandler } from "./api";
import { GOOGLE_WEB_CLIENT_ID } from "./config";

type AuthState = {
  status: "loading" | "signedOut" | "signedIn";
  signIn: () => Promise<void>;
  /** Dev builds only: sign in with an existing session token (e.g. a seeded local D1 token). */
  signInWithToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

GoogleOneTapSignIn.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });

/** Google's account picker, then the worker swaps the ID token for a Family Drive session. */
async function googleIdToken(): Promise<string | null> {
  await GoogleOneTapSignIn.checkPlayServices();
  let res = await GoogleOneTapSignIn.signIn();
  if (isNoSavedCredentialFoundResponse(res)) res = await GoogleOneTapSignIn.createAccount();
  if (isNoSavedCredentialFoundResponse(res)) res = await GoogleOneTapSignIn.presentExplicitSignIn();
  if (isCancelledResponse(res) || !isSuccessResponse(res)) return null;
  return res.data.idToken;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  const signOutLocal = useCallback(async () => {
    await saveToken(null);
    qc.clear();
    setStatus("signedOut");
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(() => void signOutLocal());
    loadToken().then((t) => setStatus(t ? "signedIn" : "signedOut"));
    return () => setUnauthorizedHandler(null);
  }, [signOutLocal]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      async signIn() {
        const idToken = await googleIdToken();
        if (!idToken) return;
        const { token } = await api<{ token: string }>("/auth/google/native", { body: { idToken } });
        await saveToken(token);
        setStatus("signedIn");
      },
      async signInWithToken(token) {
        await saveToken(token);
        try {
          await api("/me");
          setStatus("signedIn");
        } catch (err) {
          await saveToken(null);
          throw err;
        }
      },
      async signOut() {
        await api("/auth/logout", { method: "POST" }).catch(() => {});
        await GoogleOneTapSignIn.signOut().catch(() => {});
        await signOutLocal();
      },
    }),
    [status, signOutLocal],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
