import { FormEvent, useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { DashboardProvider } from "./context/DashboardContext";
import {
  VpsWorkspaceAuditPage,
  VpsWorkspaceDockerPage,
  VpsWorkspaceJobsPage,
  VpsWorkspaceLayout,
  VpsWorkspaceMetricsPage,
  VpsWorkspaceOverviewPage,
  VpsWorkspaceSettingsPage,
  VpsWorkspaceTerminalPage,
} from "./context/VpsWorkspaceContext";
import {
  DashboardLayout,
  NotFoundPage,
  VpsListPage,
  VpsNewPage,
} from "./pages/Pages";
import { AuthLoadingScreen, LoginGate } from "./components/auth/LoginGate";
import { getAuthStatus, loginWithDashboardPassword } from "./lib/api";
import { LandingPage } from "./pages/Landing";

// ── Auth state type ─────────────────────────────────────────────────

type AuthState =
  | { status: "checking" }
  | { status: "open"; mode: "demo" | "local"; authRequired: boolean }
  | { status: "locked"; mode: "demo" | "local"; message?: string };

// ── App ─────────────────────────────────────────────────────────────

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="*" element={<DashboardApp />} />
    </Routes>
  );
}

function DashboardApp() {
  const [authState, setAuthState] = useState<AuthState>({
    status: "checking",
  });
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAuthStatus()
      .then(async (auth) => {
        if (cancelled) return;
        if (!auth.authRequired || auth.authenticated) {
          setAuthState({
            status: "open",
            mode: auth.mode,
            authRequired: auth.authRequired,
          });
          return;
        }
        setAuthState({ status: "locked", mode: auth.mode });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAuthState({
          status: "locked",
          mode: "local",
          message:
            error instanceof Error
              ? error.message
              : "Unable to verify dashboard access.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = loginPassword.trim();
    if (!password) {
      setAuthState({
        status: "locked",
        mode: "local",
        message: "Enter the dashboard password to continue.",
      });
      return;
    }
    setLoginBusy(true);
    try {
      const auth = await loginWithDashboardPassword(password);
      setLoginPassword("");
      setAuthState({
        status: "open",
        mode: auth.mode,
        authRequired: auth.authRequired,
      });
    } catch (error) {
      setAuthState({
        status: "locked",
        mode: "local",
        message:
          error instanceof Error
            ? error.message
            : "Login failed. Check the password and try again.",
      });
    } finally {
      setLoginBusy(false);
    }
  }

  if (authState.status === "checking") return <AuthLoadingScreen />;
  if (authState.status === "locked") {
    return (
      <LoginGate
        password={loginPassword}
        busy={loginBusy}
        message={authState.message}
        onPasswordChange={setLoginPassword}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <DashboardProvider
      authRequired={authState.authRequired}
      onAfterLogout={
        authState.authRequired
          ? () => {
              setAuthState((prev) => ({
                status: "locked",
                mode: prev.status === "open" ? prev.mode : "local",
              }));
            }
          : undefined
      }
    >
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/vps" element={<VpsListPage />} />
          <Route path="/vps/new" element={<VpsNewPage />} />
          <Route path="/vps/:vpsId" element={<VpsWorkspaceLayout />}>
            <Route index element={<VpsWorkspaceOverviewPage />} />
            <Route path="metrics" element={<VpsWorkspaceMetricsPage />} />
            <Route path="docker" element={<VpsWorkspaceDockerPage />} />
            <Route path="jobs" element={<VpsWorkspaceJobsPage />} />
            <Route path="audit" element={<VpsWorkspaceAuditPage />} />
            <Route path="terminal" element={<VpsWorkspaceTerminalPage />} />
            <Route path="settings" element={<VpsWorkspaceSettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </DashboardProvider>
  );
}
