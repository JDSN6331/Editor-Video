import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import {
  handleFetchTranscode,
  handleFetchTranscodeProgress,
  handleFetchTranscodeStatus,
  handleFetchRenderEvents,
} from "./server/transcode-service";
import {
  handleFetchRender,
  handleFetchRenderCancel,
  handleFetchRenderResult,
  handleFetchRenderStart,
} from "./server/render-service";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

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
    try {
      const url = new URL(request.url);
      if (
        (url.pathname.startsWith("/api/transcode") || url.pathname.startsWith("/api/render")) &&
        request.method === "OPTIONS"
      ) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }
      if (url.pathname === "/api/transcode/status" && request.method === "GET") {
        return handleFetchTranscodeStatus();
      }
      if (url.pathname === "/api/transcode/progress" && request.method === "GET") {
        return handleFetchTranscodeProgress(url);
      }
      if (url.pathname === "/api/transcode" && request.method === "POST") {
        return handleFetchTranscode(request);
      }
      if (url.pathname.startsWith("/api/render/events/") && request.method === "GET") {
        return handleFetchRenderEvents(url);
      }
      if (url.pathname === "/api/render/start" && request.method === "POST") {
        return handleFetchRenderStart(request);
      }
      if (url.pathname.startsWith("/api/render/cancel/") && request.method === "POST") {
        return handleFetchRenderCancel(url);
      }
      if (url.pathname.startsWith("/api/render/result/") && request.method === "GET") {
        return handleFetchRenderResult(url);
      }
      if (
        (url.pathname === "/api/render/progress" ||
          url.pathname.startsWith("/api/render/progress/")) &&
        request.method === "GET"
      ) {
        if (!url.searchParams.has("id")) {
          url.searchParams.set("id", url.pathname.split("/").filter(Boolean).at(-1) || "");
        }
        return handleFetchTranscodeProgress(url);
      }
      if (url.pathname === "/api/render" && request.method === "POST") {
        return handleFetchRender(request);
      }

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
