/**
 * @gentech/e2e — test-only package (WP-J / Phase 3). Holds cross-cutting
 * integration tests that drive the built `dist` of the real packages end-to-end
 * (control-plane host + engine + scheduler + ingestion + presets + render-agent).
 * It ships no runtime API; this placeholder exists so the package is a valid
 * composite TS project that can reference the workspace packages it imports.
 */
export const E2E_PACKAGE = "@gentech/e2e" as const;
