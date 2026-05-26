/**
 * Thin node:http adapter (no web framework) so the mock can also run as a single
 * standalone deployable (module 13 NFR). It just unwraps JSON and forwards to a
 * MockBackend — the same object the in-process engine talks to. This is what makes
 * the swap-in proof real: point the engine's HTTP InferenceClient here and nothing
 * else changes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ComputeRequest, InferenceRequest } from "@gentech/contracts";
import { MockBackend } from "./backend.js";

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/** Wrap a MockBackend in an HTTP server. Caller owns listen()/close(). */
export function createMockServer(backend: MockBackend = new MockBackend()): Server {
  return createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "POST" && url === "/infer") {
        const body = (await readJson(req)) as InferenceRequest;
        return send(res, 200, await backend.infer(body));
      }
      if (method === "GET" && url === "/compute/inventory") {
        return send(res, 200, await backend.inventory());
      }
      if (method === "POST" && url === "/compute/lease-feasibility") {
        const body = (await readJson(req)) as ComputeRequest;
        return send(res, 200, await backend.leaseFeasibility(body));
      }
      if (method === "POST" && url === "/mock/scenario") {
        const b = (await readJson(req)) as { scenarioId: string; seed?: string | number; speed?: number };
        backend.setScenario(b.scenarioId, b.seed, b.speed);
        return send(res, 200, backend.state());
      }
      if (method === "POST" && url === "/mock/advance") {
        const b = (await readJson(req)) as { ticks?: number };
        return send(res, 200, { fired: backend.advance(b.ticks ?? 1), state: backend.state() });
      }
      if (method === "GET" && url === "/mock/state") {
        return send(res, 200, backend.state());
      }
      send(res, 404, { code: "NOT_FOUND", module: "mock-server", message: `no route ${method} ${url}` });
    } catch (err) {
      send(res, 400, {
        code: "MOCK_REQUEST_FAILED",
        module: "mock-server",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    }
  });
}
