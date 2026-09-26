import { httpServerHandler } from "cloudflare:node";

let runtimeState = globalThis.__APS_RANKING_RUNTIME || {
  loaded: false,
  app: null,
  expressHandler: null,
  initPromise: null,
};
globalThis.__APS_RANKING_RUNTIME = runtimeState;

async function getRuntime(workerEnv) {
  if (!runtimeState.loaded) {
    if (!workerEnv.HYPERDRIVE?.connectionString) {
      throw new Error("HYPERDRIVE não configurado.");
    }

    globalThis.__CF_ENV = {
      CF_WORKER: "1",
      DATABASE_URL: workerEnv.HYPERDRIVE.connectionString,
      JWT_SECRET: workerEnv.JWT_SECRET,
      ADMIN_EMAIL: workerEnv.ADMIN_EMAIL,
      ADMIN_PASSWORD: workerEnv.ADMIN_PASSWORD,
      PRIZE_START_DATE: workerEnv.PRIZE_START_DATE,
      TEAM_B_PRIZE_START_DATE: workerEnv.TEAM_B_PRIZE_START_DATE,
      SUPERVISOR_ALL_TEAMS_START_DATE: workerEnv.SUPERVISOR_ALL_TEAMS_START_DATE,
    };

    const { app, init } = await import("./server.js");
    app.listen(3000);

    runtimeState.app = app;
    runtimeState.expressHandler = httpServerHandler({ port: 3000 });
    runtimeState.init = init;
    runtimeState.loaded = true;
  }

  return runtimeState;
}

async function ensureDatabase(state) {
  if (!state.initPromise) {
    state.initPromise = state.init().catch((error) => {
      state.initPromise = null;
      throw error;
    });
  }
  return state.initPromise;
}

export default {
  async fetch(request, workerEnv, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return workerEnv.ASSETS.fetch(request);
    }

    try {
      const state = await getRuntime(workerEnv);
      await ensureDatabase(state);
      return await state.expressHandler(request, workerEnv, ctx);
    } catch (error) {
      console.error("Falha ao inicializar o banco:", error);
      return new Response("Erro ao inicializar o banco de dados.", { status: 500 });
    }
  },
};
