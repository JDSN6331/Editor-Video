import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleApiRequest } from "./server/api-router";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

const renderApiInternalUrl = String(process.env["RENDER_API_INTERNAL_URL"] || "").replace(
  /\/$/,
  "",
);

async function proxyRenderApi(request: Request): Promise<Response | null> {
  if (!renderApiInternalUrl) return null;

  const sourceUrl = new URL(request.url);
  if (
    !sourceUrl.pathname.startsWith("/api/render") &&
    !sourceUrl.pathname.startsWith("/api/transcode")
  ) {
    return null;
  }

  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, renderApiInternalUrl);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    return await fetch(targetUrl, init);
  } catch (error) {
    console.error("[render-proxy] falha ao acessar o backend", error);
    return new Response(
      JSON.stringify({ error: "O servidor do editor não conseguiu acessar o renderizador." }),
      { status: 502, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }
}

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    console.log(`[server.ts fetch] ${request.method} ${new URL(request.url).pathname}`);
    try {
      const proxiedResponse = await proxyRenderApi(request);
      if (proxiedResponse) return proxiedResponse;

      const apiResponse = await handleApiRequest(request);
      if (apiResponse) return apiResponse;

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
