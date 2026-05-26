/**
 * Module 01 — source registration (FR-1, FR-6, FR-7).
 *
 * A `SourceRegistry` records where video comes from: a live camera (RTSP / ONVIF
 * / HLS) or a chunked upload. For live sources we hold ONLY a `SecretRef` (FR-6) —
 * the raw credential is never stored. It is resolved to an `EphemeralCredential`
 * via an injected `SecretsVault` (module 02) ONLY at connect time, used to probe
 * reachability, and discarded; it never enters a `SourceRegistration` or a log.
 *
 * Owned contract types are kept LOCAL to this package (mirroring 02/10) so this
 * build never edits the shared contract files. zod is the single source of truth;
 * TS types are inferred via z.infer. We mirror the §0 ID-brand approach with a
 * local `Id` primitive.
 */
import { z } from "zod";
import {
  ContractError,
  CompressionPlanSchema,
  type AuthContext,
  type CompressionPlan,
} from "@gentech/contracts";
import type { SecretRef, SecretsVault } from "@gentech/secrets";

// Local id primitive — opaque, non-empty (mirrors §0 brand approach).
const Id = z.string().min(1);

export const SourceKindSchema = z.enum(["live", "upload"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** Wire protocols we can connect to for a live source (FR-1). */
export const LiveProtocolSchema = z.enum(["rtsp", "onvif", "hls"]);
export type LiveProtocol = z.infer<typeof LiveProtocolSchema>;

export const SourceHealthSchema = z.enum(["online", "degraded", "offline"]);
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

/**
 * Persisted record of a registered source. Holds a `secretRef` (opaque handle)
 * for live sources — NEVER a raw credential (FR-6).
 */
export const SourceRegistrationSchema = z.object({
  sourceId: Id,
  tenantId: Id,
  kind: SourceKindSchema,
  protocol: LiveProtocolSchema.optional(), // live only
  uri: z.string().optional(), // live only (e.g. rtsp://cam.local/stream)
  secretRef: z.string().optional(), // opaque SecretRef; resolved at connect time only
  compression: CompressionPlanSchema.optional(), // negotiated plan (FR-3)
  status: SourceHealthSchema,
});
export type SourceRegistration = z.infer<typeof SourceRegistrationSchema>;

export interface RegisterLiveInput {
  sourceId?: string;
  tenantId: string;
  protocol: LiveProtocol;
  uri: string;
  secretRef?: SecretRef;
  compression?: CompressionPlan;
}

export interface RegisterUploadInput {
  sourceId?: string;
  tenantId: string;
  compression?: CompressionPlan;
}

function badRequest(message: string): never {
  throw new ContractError({ code: "INGEST_BAD_SOURCE", module: "ingestion", message, retryable: false });
}

let seq = 0;
function freshSourceId(): string {
  return `src_${Date.now().toString(36)}${(++seq).toString(36).padStart(3, "0")}`;
}

/**
 * Registry of media sources. Live registrations carry only a `SecretRef`; the
 * raw value is resolved lazily via the injected vault at `connect` time (FR-6).
 */
export class SourceRegistry {
  private readonly byId = new Map<string, SourceRegistration>();

  constructor(private readonly vault: SecretsVault) {}

  /** Register a live camera source. The raw credential is never touched here. */
  registerLive(input: RegisterLiveInput): SourceRegistration {
    if (!input.uri) badRequest("live source requires a uri");
    const reg: SourceRegistration = SourceRegistrationSchema.parse({
      sourceId: input.sourceId ?? freshSourceId(),
      tenantId: input.tenantId,
      kind: "live",
      protocol: input.protocol,
      uri: input.uri,
      secretRef: input.secretRef as string | undefined,
      compression: input.compression,
      status: "offline", // not yet probed
    });
    this.byId.set(reg.sourceId, reg);
    return reg;
  }

  /** Register an upload source (bytes pushed in via an upload session). */
  registerUpload(input: RegisterUploadInput): SourceRegistration {
    const reg: SourceRegistration = SourceRegistrationSchema.parse({
      sourceId: input.sourceId ?? freshSourceId(),
      tenantId: input.tenantId,
      kind: "upload",
      compression: input.compression,
      status: "online", // ready to receive chunks immediately
    });
    this.byId.set(reg.sourceId, reg);
    return reg;
  }

  get(sourceId: string): SourceRegistration | undefined {
    return this.byId.get(sourceId);
  }

  /** Current health for `GET /sources/{id}/health` (FR-7). */
  health(sourceId: string): SourceHealth {
    const reg = this.byId.get(sourceId);
    if (!reg) badRequest(`unknown source ${sourceId}`);
    return reg.status;
  }

  /**
   * Test-connect a live source (FR-1). Resolves the `SecretRef` to a short-lived
   * `EphemeralCredential` via the vault, "probes" reachability with the injected
   * prober, then DISCARDS the credential. The raw value never leaves this method:
   * it is not stored on the registration, returned, or logged. Updates and returns
   * the resulting health.
   */
  connect(
    auth: AuthContext,
    sourceId: string,
    prober: (probe: { uri: string; username?: string; password: string }) => boolean = () => true,
  ): SourceHealth {
    const reg = this.byId.get(sourceId);
    if (!reg) badRequest(`unknown source ${sourceId}`);
    if (reg.kind !== "live") badRequest(`source ${sourceId} is not a live source`);
    if (reg.tenantId !== auth.tenantId) badRequest("cross-tenant source access denied");

    let reachable: boolean;
    if (reg.secretRef) {
      // Resolve creds ONLY here; the value lives for the duration of the probe.
      const cred = this.vault.resolve(auth, reg.secretRef as unknown as SecretRef);
      reachable = prober({ uri: reg.uri!, password: cred.value });
      // cred goes out of scope immediately; never persisted/returned.
    } else {
      reachable = prober({ uri: reg.uri!, password: "" });
    }

    const next: SourceHealth = reachable ? "online" : "offline";
    this.byId.set(sourceId, { ...reg, status: next });
    return next;
  }

  /** Mark a source's observed health (FR-7) — e.g. on stream stall → degraded. */
  setHealth(sourceId: string, status: SourceHealth): void {
    const reg = this.byId.get(sourceId);
    if (!reg) badRequest(`unknown source ${sourceId}`);
    this.byId.set(sourceId, { ...reg, status });
  }
}
