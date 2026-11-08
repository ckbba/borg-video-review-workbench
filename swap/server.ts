// Vite plugin for the swap app. Deliberately thin: it loads ./handler.ts on each request through Vite's SSR module
// graph, so the engine is not part of the config's import graph and editing it never restarts the dev server.
import type { Plugin, ViteDevServer } from 'vite';

export function swapApi(): Plugin {
  return {
    name: 'swap-api',
    configureServer(server: ViteDevServer) {
      const handler = () => server.ssrLoadModule('/swap/handler.ts');
      void handler().then(m => m.recoverJobs()); // once per real start: mark jobs a previous process left mid-way
      server.middlewares.use('/swap-files', async (req: any, res: any) => (await handler()).handleFiles(req, res));
      server.middlewares.use('/api/swap', async (req: any, res: any) => (await handler()).handleApi(req, res));
    }
  };
}
