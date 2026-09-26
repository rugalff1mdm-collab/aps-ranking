import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";

if (!env.HYPERDRIVE?.connectionString) {
  throw new Error("HYPERDRIVE não configurado. Vincule uma configuração Hyperdrive como HYPERDRIVE.");
}

globalThis.__CF_ENV = {
  CF_WORKER: "1",
  DATABASE_URL: env.HYPERDRIVE.connectionString,
  JWT_SECRET: env.JWT_SECRET,
  ADMIN_EMAIL: env.ADMIN_EMAIL,
  ADMIN_PASSWORD: env.ADMIN_PASSWORD,
  PRIZE_START_DATE: env.PRIZE_START_DATE,
  TEAM_B_PRIZE_START_DATE: env.TEAM_B_PRIZE_START_DATE,
  SUPERVISOR_ALL_TEAMS_START_DATE: env.SUPERVISOR_ALL_TEAMS_START_DATE,
};

const { app, init } = await import("./server.js");

app.listen(3000);
const expressHandler = httpServerHandler({ port: 3000 });

let initPromise;
async function ensureDatabase() {
  if (!initPromise) {
    initPromise = init().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

export default {
  async fetch(request, workerEnv, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return workerEnv.ASSETS.fetch(request);
    }

    try {
      await ensureDatabase();
      return await expressHandler(request, workerEnv, ctx);
    } catch (error) {
      console.error("Falha ao inicializar o banco:", error);
      return new Response("Erro ao inicializar o banco de dados.", { status: 500 });
    }
  },
};
