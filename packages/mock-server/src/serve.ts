/** Standalone entrypoint: `pnpm --filter @gentech/mock-server serve`. */
import { MockBackend } from "./backend.js";
import { createMockServer } from "./http.js";

const PORT = Number(process.env.PORT ?? 8713);
const scenarioId = process.env.SCENARIO ?? "parking_lot_daytime";
const seed = process.env.SEED ?? "default";

const backend = new MockBackend({ scenarioId, seed });
createMockServer(backend).listen(PORT, () => {
  console.log(`[mock-server] listening on http://localhost:${PORT}  scenario=${scenarioId} seed=${seed}`);
  console.log(`  POST /infer  GET /compute/inventory  POST /compute/lease-feasibility`);
  console.log(`  control: POST /mock/scenario  POST /mock/advance  GET /mock/state`);
});
