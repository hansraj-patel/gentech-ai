/**
 * Dev API server for apps/web. This is the ONLY entry that imports
 * `@gentech/control-plane` (which pulls in node:http and the whole backend).
 * The browser bundle never imports it — Vite dev-proxies /api -> here.
 *
 * Run with: pnpm --filter @gentech/web serve:api
 */
import { createGatewayHost } from "@gentech/control-plane";

const PORT = Number(process.env.PORT ?? 8787);

async function main(): Promise<void> {
  const { gateway } = createGatewayHost();
  const port = await gateway.listen(PORT);
  // eslint-disable-next-line no-console
  console.log(`[gentech-web] control-plane gateway listening on http://localhost:${port}`);
  console.log(`[gentech-web] routes: POST /query  GET /events  GET /jobs/:id  GET /traces/:id`);
  console.log(`[gentech-web] Vite dev server proxies /api -> this port.`);
}

main().catch((err) => {
  console.error("[gentech-web] failed to start gateway:", err);
  process.exit(1);
});
