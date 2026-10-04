import { createServer } from "node:http";
import { handleNodeApi } from "../src/server/node-handler";

const port = Number(process.env["RENDER_PORT"] || process.env["PORT"] || 3001);
const host = process.env["RENDER_HOST"] || process.env["HOST"] || "0.0.0.0";

const server = createServer(async (request, response) => {
  try {
    const handled = await handleNodeApi(request, response);
    if (!handled && !response.headersSent) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "Endpoint não encontrado." }));
    }
  } catch (error) {
    console.error("[render-api] erro não tratado", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: "Erro interno no servidor de renderização." }));
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;

server.on("clientError", (error, socket) => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") {
    socket.destroy();
    return;
  }
  console.error("[render-api] conexão inválida", error.message);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(port, host, () => {
  console.log(`[render-api] ouvindo em http://${host}:${port}`);
  console.log("[render-api] frontend e FFmpeg estão em processos separados");
});

function shutdown(signal: string): void {
  console.log(`[render-api] ${signal}; encerrando servidor HTTP`);
  server.close((error) => {
    if (error) {
      console.error("[render-api] falha ao encerrar", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
