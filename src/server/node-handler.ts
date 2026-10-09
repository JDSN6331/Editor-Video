import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { handleFetchTranscodeStatus, handleFetchTranscodeProgress } from "./transcode-service";
import {
  saveUploadStream,
  startRenderJob,
  getRenderResultInfo,
  cancelRenderJob,
  sanitizeDownloadName,
  startGoogleDriveUpload,
  getGoogleDriveUploadState,
  cancelGoogleDriveUpload,
} from "./render-service";

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const configuredOrigins = (process.env["FRONTEND_ORIGIN"] || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const requestOrigin = req.headers.origin?.replace(/\/$/, "");
  const allowedOrigin =
    requestOrigin && (configuredOrigins.length === 0 || configuredOrigins.includes(requestOrigin))
      ? requestOrigin
      : configuredOrigins[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers":
      "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Manipulador nativo de rotas da API para o servidor de desenvolvimento Node (Vite).
 *
 * Utiliza diretamente streams do Node (IncomingMessage / ServerResponse) sem converter
 * para Web Request / ReadableStream, evitando travamentos de sockets e deadlocks de streaming
 * no Windows.
 */
export async function handleNodeApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const requestUrl = req.url || "/";
  const url = new URL(requestUrl, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "");
  const method = (req.method || "GET").toUpperCase();

  if (!pathname.startsWith("/api/transcode") && !pathname.startsWith("/api/render")) {
    return false;
  }

  for (const [key, value] of Object.entries(corsHeaders(req))) {
    res.setHeader(key, value);
  }

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  console.log(`[node-api] ${method} ${pathname}`);

  try {
    if (pathname === "/api/transcode/status" && method === "GET") {
      const resp = await handleFetchTranscodeStatus();
      const body = await resp.text();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
      return true;
    }

    if (
      (pathname === "/api/render/progress" || pathname === "/api/transcode/progress") &&
      method === "GET"
    ) {
      const resp = await handleFetchTranscodeProgress(url);
      const body = await resp.text();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
      return true;
    }

    if (pathname === "/api/render/upload" && method === "POST") {
      const id = url.searchParams.get("id") || "";
      const kind = url.searchParams.get("kind") || "";
      const parsedIndex = Number.parseInt(url.searchParams.get("index") || "0", 10);
      const index = Number.isFinite(parsedIndex) ? Math.max(0, Math.min(9999, parsedIndex)) : 0;
      const originalName = url.searchParams.get("name") || "asset.bin";
      const contentLengthHeader = req.headers["content-length"];
      const declaredLength = contentLengthHeader ? Number(contentLengthHeader) : null;

      const result = await saveUploadStream(id, kind, index, originalName, req, declaredLength);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(result));
      return true;
    }

    if (pathname === "/api/render" && method === "POST") {
      const id = url.searchParams.get("id") || "";
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawText = Buffer.concat(chunks).toString("utf-8");
      const body = JSON.parse(rawText || "{}");
      const result = await startRenderJob(id, body);
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return true;
    }

    if (pathname === "/api/render/result" && (method === "GET" || method === "HEAD")) {
      const id = url.searchParams.get("id") || "";
      const isDownload = url.searchParams.get("download") === "1";
      const customFilename = url.searchParams.get("filename");
      const rangeHeader = (req.headers["range"] as string) || null;

      const info = await getRenderResultInfo(id, rangeHeader);
      res.statusCode = info.status;
      for (const [k, v] of Object.entries(info.headers)) {
        res.setHeader(k, v);
      }
      if (isDownload) {
        const downloadName = sanitizeDownloadName(customFilename, info.format);
        res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
      }

      if (method === "HEAD") {
        res.end();
        return true;
      }

      const stream = createReadStream(info.path, { start: info.start, end: info.end });
      stream.pipe(res);
      return true;
    }

    if (pathname === "/api/render/drive-upload" && method === "POST") {
      const id = url.searchParams.get("id") || "";
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buffer = chunk as Buffer;
        total += buffer.length;
        if (total > 64 * 1024) throw new Error("Configuração do Drive muito grande.");
        chunks.push(buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        accessToken?: string;
        fileName?: string;
        folderName?: string;
      };
      const state = await startGoogleDriveUpload(
        id,
        body.accessToken || "",
        body.fileName || "video.mp4",
        body.folderName || "Editor de Vídeo",
      );
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(state));
      return true;
    }

    if (pathname === "/api/render/drive-progress" && method === "GET") {
      const id = url.searchParams.get("id") || "";
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(getGoogleDriveUploadState(id)));
      return true;
    }

    if (pathname === "/api/render/drive-cancel" && method === "POST") {
      cancelGoogleDriveUpload(url.searchParams.get("id") || "");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (pathname === "/api/render/cancel" && method === "POST") {
      const id = url.searchParams.get("id") || "";
      await cancelRenderJob(id);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Endpoint não encontrado" }));
    return true;
  } catch (error) {
    const statusError = error as { status?: number; rangeHeader?: string };
    if (statusError.status === 416) {
      res.statusCode = 416;
      res.setHeader("Content-Range", statusError.rangeHeader || "");
      res.end();
      return true;
    }
    console.error("[node-api-error]", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
    }
    res.end(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro no servidor." }),
    );
    return true;
  }
}
