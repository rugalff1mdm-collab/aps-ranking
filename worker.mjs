import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";

// Adapta o Express existente para o runtime do Cloudflare Workers.
// O banco continua sendo o PostgreSQL atual, acessado pelo Hyperdrive.
globalThis.__CF_ENV = {
  CF_WORKER: "1",
  DATABASE_URL: env.HYPERDRIVE?.connectionString,
  JWT_SECRET: env.JWT_SECRET,
  ADMIN_EMAIL: env.ADMIN_EMAIL,
  ADMIN_PASSWORD: env.ADMIN_PASSWORD,
};

if (!env.HYPERDRIVE?.connectionString) {
  throw new Error(
    "HYPERDRIVE não configurado. Conecte o PostgreSQL existente e vincule-o como HYPERDRIVE."
  );
}

const { app, init } = await import("./server.js");

// O Express precisa estar ouvindo em uma porta interna para o
// httpServerHandler encaminhar as requisições /api/*.
app.listen(3000);

// Garante que as tabelas/migrações existam antes de atender as primeiras requisições.
await init();

const expressHandler = httpServerHandler({ port: 3000 });

export default {
  async fetch(request, workerEnv, ctx) {
    const url = new URL(request.url);

    // APIs continuam no Express.
    if (url.pathname.startsWith("/api/")) {
      return expressHandler.fetch(request, workerEnv, ctx);
    }

    // HTML/CSS/JS/imagens são entregues pelo Workers Static Assets.
    return env.ASSETS.fetch(request);
  },
};
