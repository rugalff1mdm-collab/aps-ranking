import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";

// Hyperdrive supplies the secure database connection string at runtime.
// The optional env vars keep the existing admin/JWT configuration working.
if (!env.HYPERDRIVE?.connectionString) {
  throw new Error("HYPERDRIVE não configurado. Vincule uma configuração Hyperdrive como HYPERDRIVE.");
}

process.env.CF_WORKER = "1";
process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
if (env.JWT_SECRET) process.env.JWT_SECRET = env.JWT_SECRET;
if (env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = env.ADMIN_EMAIL;
if (env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = env.ADMIN_PASSWORD;

const { app, init } = await import("./server.js");
await init();

// Cloudflare's Node HTTP bridge routes /api/* requests to Express.
// Static files in /public are served by Workers Static Assets.
app.listen(3000);

export default httpServerHandler({ port: 3000 });
