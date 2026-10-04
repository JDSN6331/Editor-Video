import {
  handleFetchTranscode,
  handleFetchTranscodeProgress,
  handleFetchTranscodeStatus,
} from "./transcode-service";
import {
  handleFetchRender,
  handleFetchRenderCancel,
  handleFetchRenderResult,
  handleFetchRenderUpload,
} from "./render-service";

const CORS_PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Max-Age": "86400",
};

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/transcode") || pathname.startsWith("/api/render");
}

/**
 * Roteador único das rotas /api/* do servidor FFmpeg.
 *
 * É usado tanto pelo servidor de produção (src/server.ts / Nitro) quanto pelo
 * servidor de desenvolvimento (vite.config.ts), garantindo que os dois
 * ambientes se comportem exatamente igual. Retorna `null` quando a rota não é
 * da API, para que o chamador siga para o restante da aplicação.
 */
export async function handleApiRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!isApiPath(pathname)) return null;

  const method = (request.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
  }

  if (pathname === "/api/transcode/status" && method === "GET") {
    return handleFetchTranscodeStatus();
  }
  if (
    (pathname === "/api/transcode/progress" || pathname === "/api/render/progress") &&
    method === "GET"
  ) {
    return handleFetchTranscodeProgress(url);
  }
  if (pathname === "/api/transcode" && method === "POST") {
    return handleFetchTranscode(request);
  }
  if (pathname === "/api/render/upload" && method === "POST") {
    return handleFetchRenderUpload(request);
  }
  if (pathname === "/api/render" && method === "POST") {
    return handleFetchRender(request);
  }
  if (pathname === "/api/render/result" && (method === "GET" || method === "HEAD")) {
    return handleFetchRenderResult(request);
  }
  if (pathname === "/api/render/cancel" && method === "POST") {
    return handleFetchRenderCancel(request);
  }
  return new Response(JSON.stringify({ error: "Endpoint não encontrado" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
