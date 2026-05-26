import React, { useState } from "react";
import { useAuth } from "../App";
import type { Role } from "../api";

const ROLES: Array<{ role: Role; desc: string }> = [
  { role: "analyst", desc: "Full query access · can run inference pipelines" },
  { role: "operator", desc: "Operational dashboards · monitors & alerts" },
  { role: "viewer", desc: "Read-only · limited scopes" },
];

export function Login(): React.ReactElement {
  const { login } = useAuth();
  const [tenantId, setTenantId] = useState("ten_demo");

  return (
    <div className="login">
      <h1>Sign in</h1>
      <p className="muted">Pick a role (no real IdP in v1) — sets your AuthContext.</p>
      <label className="field">
        <span>Tenant</span>
        <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
      </label>
      <div className="role-cards">
        {ROLES.map(({ role, desc }) => (
          <button
            key={role}
            className="role-card"
            disabled={!tenantId.trim()}
            onClick={() => login({ role, tenantId: tenantId.trim() })}
          >
            <div className="role-card-title">{role}</div>
            <div className="role-card-desc">{desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
