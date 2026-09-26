import { httpServerHandler } from "cloudflare:node";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

let runtimeState = globalThis.__APS_RANKING_RUNTIME || {
  loaded: false,
  app: null,
  expressHandler: null,
  initPromise: null,
};
globalThis.__APS_RANKING_RUNTIME = runtimeState;

async function loginDirect(request, workerEnv) {
  try {
    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');

    if (!email || !password) {
      return Response.json({ error: 'Informe e-mail e senha' }, { status: 400 });
    }

    if (!workerEnv.HYPERDRIVE?.connectionString) {
      throw new Error('HYPERDRIVE não configurado.');
    }

    const client = new Client({
      connectionString: workerEnv.HYPERDRIVE.connectionString,
    });

    try {
      await client.connect();
      const result = await client.query(
        'SELECT * FROM users WHERE email=$1 AND active=1 LIMIT 1',
        [email]
      );
      const user = result.rows[0];

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return Response.json({ error: 'E-mail ou senha inválidos' }, { status: 401 });
      }

      const secret = workerEnv.JWT_SECRET || 'TROQUE-ESTE-SEGREDO-EM-PRODUCAO';
      const token = jwt.sign(
        { id: user.id, name: user.name, email: user.email, role: user.role },
        secret,
        { expiresIn: '7d' }
      );

      return Response.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          goal: user.goal,
          photo_data: user.photo_data || null,
        },
      });
    } finally {
      await client.end().catch(() => {});
    }
  } catch (error) {
    console.error('Falha no login direto:', error);
    return Response.json({ error: 'Erro interno ao realizar login' }, { status: 500 });
  }
}

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

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return loginDirect(request, workerEnv);
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
