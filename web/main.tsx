import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { ApiError } from "./lib/api";
import { ToastProvider } from "./ui/primitives";
import { DriveUIProvider } from "./ui/DriveUI";
import { AppShell } from "./ui/AppShell";
import { FolderPage, HomePage, MyDrivePage, NotFoundPage, RecentPage, SearchPage, SharedPage, StarredPage, TrashPage } from "./pages/drive";
import { FamilyPage, FileLinkPage, LoginPage, PublicSharePage } from "./pages/other";
import { PrivacyPage, TermsPage } from "./pages/legal";
import { GoogleSyncPage } from "./pages/gsync";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Mutations invalidate what they change, so refocusing the tab doesn't need to refetch every view.
      staleTime: 60_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <DriveUIProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/s/:token" element={<PublicSharePage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route element={<AppShell />}>
                <Route index element={<HomePage />} />
                <Route path="drive" element={<MyDrivePage />} />
                <Route path="folders/:id" element={<FolderPage />} />
                <Route path="file/:id" element={<FileLinkPage />} />
                <Route path="shared" element={<SharedPage />} />
                <Route path="recent" element={<RecentPage />} />
                <Route path="starred" element={<StarredPage />} />
                <Route path="trash" element={<TrashPage />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="family" element={<FamilyPage />} />
                <Route path="google-sync" element={<GoogleSyncPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </DriveUIProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
