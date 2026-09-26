import { handleAsNodeRequest } from "cloudflare:node";

let readyPromise = null;

async function ensureServer(env) {
  if (!readyPromise) {
    readyPromise = (async () => {
      // Pass Cloudflare bindings/environment to the existing Express backend
      // before importing it, because server.js reads its environment at load time.
      globalThis.__CF_ENV = {
        ...env,
        CF_WORKER: "1",
        DATABASE_URL: env.HYPERDRIVE?.connectionString || env.DATABASE_URL,
      };

      const mod = await import("./server.js");
      await mod.init();

      // In Workers this port is only an internal routing key.
      if (!mod.app.listening) {
        mod.app.listen(3000);
      }
    })();
  }

  await readyPromise;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Static frontend files are served by Cloudflare Assets.
    // Only API requests need to reach Express.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    await ensureServer(env);
    return handleAsNodeRequest(3000, request);
  },
};
