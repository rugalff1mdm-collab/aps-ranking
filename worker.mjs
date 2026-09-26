import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";

if (!env.HYPERDRIVE?.connectionString) {
  throw new Error("HYPERDRIVE não configurado. Crie uma configuração Hyperdrive e vincule-a como HYPERDRIVE.");
}

process.env.CF_WORKER = "1";
process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
if (env.JWT_SECRET) process.env.JWT_SECRET = env.JWT_SECRET;
if (env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = env.ADMIN_EMAIL;
if (env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = env.ADMIN_PASSWORD;

const serverModule = (await import("./server.js")).default;
const { app, init } = serverModule;

await init();
app.listen(3000);

export default httpServerHandler({ port: 3000 });
