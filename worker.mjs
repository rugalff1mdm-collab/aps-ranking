import { handleAsNodeRequest } from "cloudflare:node";
import { createServer } from "node:http";

import { env } from "cloudflare:workers";

globalThis.__CF_ENV = {
  CF_WORKER: "1",
  DATABASE_URL: env.HYPERDRIVE?.connectionString,
  JWT_SECRET: env.JWT_SECRET,
  ADMIN_EMAIL: env.ADMIN_EMAIL,
  ADMIN_PASSWORD: env.ADMIN_PASSWORD,
  PRIZE_START_DATE: env.PRIZE_START_DATE,
  TEAM_B_PRIZE_START_DATE: env.TEAM_B_PRIZE_START_DATE,
  SUPERVISOR_ALL_TEAMS_START_DATE: env.SUPERVISOR_ALL_TEAMS_START_DATE,
};

const { app } = await import("./server.js");
const runtimeServer = createServer(app);
await new Promise((resolve, reject) => {
  runtimeServer.once("listening", resolve);
  runtimeServer.once("error", reject);
  runtimeServer.listen(3000);
});

export default {
  async fetch(request, workerEnv, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return workerEnv.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const connectionString = workerEnv.HYPERDRIVE?.connectionString;
      if (!connectionString) return Response.json({ ok: false, error: "HYPERDRIVE não configurado" }, { status: 500 });
      try {
        const { Client } = await import("pg");
        const client = new Client({ connectionString });
        await client.connect();
        const result = await client.query("SELECT 1 AS ok");
        await client.end().catch(() => {});
        return Response.json({ ok: true, database: result.rows[0]?.ok === 1 });
      } catch (error) {
        console.error("Healthcheck Hyperdrive:", error);
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        return await loginDirect(request, workerEnv);
      } catch (error) {
        console.error("Falha inesperada no login:", error);
        return Response.json({ error: "Erro interno ao realizar login" }, { status: 500 });
      }
    }

    try {
      return await handleAsNodeRequest(3000, request);
    } catch (error) {
      console.error("Erro no endpoint do Worker:", error);
      return Response.json({ error: "Erro interno", detail: String(error?.message || error).slice(0, 500) }, { status: 500 });
    }
  },
};
