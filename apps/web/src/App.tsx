import React, { createContext, useContext, useState } from "react";
import type { Role } from "./api";
import { Login } from "./screens/Login";
import { Chat } from "./screens/Chat";
import { JobDetail } from "./screens/JobDetail";

export interface Auth {
  role: Role;
  tenantId: string;
}

interface AuthCtx {
  auth: Auth | null;
  login: (auth: Auth) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthCtx>({
  auth: null,
  login: () => undefined,
  logout: () => undefined,
});

export function useAuth(): AuthCtx {
  return useContext(AuthContext);
}

export type Screen =
  | { name: "login" }
  | { name: "chat" }
  | { name: "job"; jobId: string; traceId: string };

interface NavCtx {
  screen: Screen;
  go: (s: Screen) => void;
}

const NavContext = createContext<NavCtx>({ screen: { name: "login" }, go: () => undefined });

export function useNav(): NavCtx {
  return useContext(NavContext);
}

export function App(): React.ReactElement {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "login" });

  const authValue: AuthCtx = {
    auth,
    login: (a) => {
      setAuth(a);
      setScreen({ name: "chat" });
    },
    logout: () => {
      setAuth(null);
      setScreen({ name: "login" });
    },
  };

  const navValue: NavCtx = { screen, go: setScreen };

  let body: React.ReactElement;
  if (!auth || screen.name === "login") {
    body = <Login />;
  } else if (screen.name === "chat") {
    body = <Chat />;
  } else {
    body = <JobDetail jobId={screen.jobId} traceId={screen.traceId} />;
  }

  return (
    <AuthContext.Provider value={authValue}>
      <NavContext.Provider value={navValue}>
        <div className="app">
          <header className="topbar">
            <div className="brand">
              GenTech AI <span className="brand-sub">intelligence real · pixels faked</span>
            </div>
            {auth ? (
              <div className="topbar-right">
                <span className="role-badge">{auth.role}</span>
                <span className="tenant-badge">{auth.tenantId}</span>
                {screen.name !== "chat" ? (
                  <button className="link-btn" onClick={() => setScreen({ name: "chat" })}>
                    ← Chat
                  </button>
                ) : null}
                <button className="link-btn" onClick={authValue.logout}>
                  logout
                </button>
              </div>
            ) : null}
          </header>
          <main className="main">{body}</main>
        </div>
      </NavContext.Provider>
    </AuthContext.Provider>
  );
}
