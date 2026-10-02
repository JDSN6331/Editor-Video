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
        name: "native-ffmpeg-dev-server",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const requestUrl = req.url || "/";
            const pathname = new URL(requestUrl, "http://localhost").pathname;
            if (!pathname.startsWith("/api/transcode") && !pathname.startsWith("/api/render")) {
              next();
              return;
            }

            try {
              const origin = `http://${req.headers.host || "localhost"}`;
              const headers = new Headers();
              for (const [name, value] of Object.entries(req.headers)) {
                if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
                else if (value !== undefined) headers.set(name, value);
              }

              const init: RequestInit & { duplex?: "half" } = {
                method: req.method,
                headers,
              };
              if (req.method !== "GET" && req.method !== "HEAD") {
                const { Readable } = await import("node:stream");
                init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
                init.duplex = "half";
              }
              const request = new Request(new URL(requestUrl, origin), init);
              const url = new URL(request.url);
              const transcode = await import("./src/server/transcode-service.js");
              const renderer = await import("./src/server/render-service.js");

              let response: Response;
              if (pathname.startsWith("/api/render/events/") && request.method === "GET") {
                response = transcode.handleFetchRenderEvents(url);
              } else if (pathname === "/api/transcode/status" && request.method === "GET") {
                response = await transcode.handleFetchTranscodeStatus();
              } else if (pathname === "/api/transcode/progress" && request.method === "GET") {
                response = await transcode.handleFetchTranscodeProgress(url);
              } else if (pathname === "/api/transcode" && request.method === "POST") {
                response = await transcode.handleFetchTranscode(request);
              } else if (
                (pathname === "/api/render/progress" ||
                  pathname.startsWith("/api/render/progress/")) &&
                request.method === "GET"
              ) {
                if (!url.searchParams.has("id")) {
                  url.searchParams.set("id", pathname.split("/").filter(Boolean).at(-1) || "");
                }
                response = await transcode.handleFetchTranscodeProgress(url);
              } else if (pathname === "/api/render" && request.method === "POST") {
                response = await renderer.handleFetchRender(request);
              } else {
                response = new Response("Not Found", { status: 404 });
              }

              res.statusCode = response.status;
              response.headers.forEach((value, name) => res.setHeader(name, value));
              if (!response.body) {
                res.end();
                return;
              }
              const reader = response.body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
              res.end();
            } catch (error) {
              console.error("[vite-ffmpeg-dev]", error);
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
              }
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "Erro no servidor FFmpeg local.",
                }),
              );
            }
          });
        },
      },
    ],
    server: {
      strictPort: false,
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
