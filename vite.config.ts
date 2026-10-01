// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    plugins: [
      {
        name: "ffmpeg-dev-server",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const url = req.url || "";
            if (url.startsWith("/api/transcode")) {
              try {
                const { handleNodeTranscodeMiddleware } = await import(
                  "./src/server/transcode-service.js"
                );
                await handleNodeTranscodeMiddleware(req, res);
              } catch (err) {
                console.error("[vite-ffmpeg-dev] Erro no middleware:", err);
                if (!res.headersSent) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: "Erro no servidor FFmpeg local." }));
                }
              }
              return;
            }
            next();
          });
        },
      },
    ],
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  nitro: {
    preset: process.env.NITRO_PRESET || "node-server",
  },
});
