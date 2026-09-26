import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";

// Expose Cloudflare bindings to the existing Express app before server.js is imported.
// This makes server.js stay in Worker mode: it won't call app.listen(), serve static
// files through Express, or try to exit the Worker process.
globalThis.__CF_ENV = {
  CF_WORKER: "1",
  DATABASE_URL: env.HYPERDRIVE?.connectionString,
  JWT_SECRET: env.JWT_SECRET,
  ADMIN_EMAIL: env.ADMIN_EMAIL,
  ADMIN_PASSWORD: env.ADMIN_PASSWORD,
};

if (!env.HYPERDRIVE?.connectionString) {
  throw new Error("HYPERDRIVE não configurado. Vincule uma configuração Hyperdrive como HYPERDRIVE.");
}

const { app, init } = await import("./server.js");
await init();

// Express handles the API through Cloudflare's Node HTTP bridge.
// Static assets are served by Workers Static Assets.
export default httpServerHandler({ port: 3000 });
