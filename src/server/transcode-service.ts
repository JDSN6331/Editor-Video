import { spawn, execSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

let cachedFfmpegPath: string | null = null;
let ffmpegChecked = false;
let ffmpegDiagnostic = "FFmpeg ainda nao foi verificado.";

export interface TranscodeJobProgress {
  status: "uploading" | "encoding" | "done" | "error";
  timeSec: number;
  fps: number;
  speed: string;
  error?: string;
}

export const activeJobs = new Map<string, TranscodeJobProgress>();
const lastProgressLog = new Map<string, number>();

/**
 * Localiza o executável nativo do FFmpeg no sistema operacional
 * (compatível com Windows local e Linux VPS / Docker / Easypanel).
 */
export function getFfmpegPath(): string | null {
  if (ffmpegChecked && cachedFfmpegPath) return cachedFfmpegPath;

  // 1. Variável de ambiente explícita
  const customFfmpeg = process.env["FFMPEG_PATH"];
  if (customFfmpeg && existsSync(customFfmpeg)) {
    cachedFfmpegPath = customFfmpeg;
    ffmpegChecked = true;
    ffmpegDiagnostic = `FFmpeg localizado por FFMPEG_PATH: ${customFfmpeg}`;
    return cachedFfmpegPath;
  }

  // Imagens Linux enxutas nem sempre oferecem `which`, embora o executavel
  // instalado pelo apt esteja presente em um destes caminhos.
  if (process.platform !== "win32") {
    for (const candidate of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg"]) {
      if (existsSync(candidate)) {
        cachedFfmpegPath = candidate;
        ffmpegChecked = true;
        ffmpegDiagnostic = `FFmpeg localizado em ${candidate}`;
        return cachedFfmpegPath;
      }
    }
  }

  // 2. Busca no PATH ou caminhos comuns por SO
  try {
    if (process.platform === "win32") {
      const wingetPath = path.join(
        process.env["LOCALAPPDATA"] || "",
        "Microsoft",
        "WinGet",
        "Links",
        "ffmpeg.exe",
      );
      if (existsSync(wingetPath)) {
        cachedFfmpegPath = wingetPath;
        ffmpegChecked = true;
        ffmpegDiagnostic = `FFmpeg localizado em ${wingetPath}`;
        return cachedFfmpegPath;
      }

      const out = execSync("where ffmpeg", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim()
        .split("\r\n")[0];
      if (out && existsSync(out)) {
        cachedFfmpegPath = out;
        ffmpegChecked = true;
        ffmpegDiagnostic = `FFmpeg localizado em ${out}`;
        return cachedFfmpegPath;
      }
    } else {
      const out = execSync("which ffmpeg || command -v ffmpeg", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (out && existsSync(out)) {
        cachedFfmpegPath = out;
        ffmpegChecked = true;
        ffmpegDiagnostic = `FFmpeg localizado em ${out}`;
        return cachedFfmpegPath;
      }
    }
  } catch {
    // FFmpeg não encontrado diretamente
  }

  // 3. Fallback: tentar chamar diretamente "ffmpeg"
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    cachedFfmpegPath = "ffmpeg";
    ffmpegChecked = true;
    ffmpegDiagnostic = "FFmpeg localizado no PATH do processo.";
    return cachedFfmpegPath;
  } catch {
    cachedFfmpegPath = null;
    // Nao memorize falhas: PATH/volumes podem ser disponibilizados depois que
    // o processo iniciou (comum em containers e plataformas de deploy).
    ffmpegChecked = false;
    ffmpegDiagnostic =
      "Executavel FFmpeg ausente. Use a imagem Docker do projeto ou configure FFMPEG_PATH.";
    return null;
  }
}

export function getFfmpegDiagnostic(): string {
  return ffmpegDiagnostic;
}

export function isFfmpegAvailable(): boolean {
  return getFfmpegPath() !== null;
}

export function getFfmpegVersion(): string {
  const binary = getFfmpegPath();
  if (!binary) return "Não disponível";
  try {
    const out = execSync(`"${binary}" -version`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split("\n")[0];
    return (out || "").trim();
  } catch {
    return "Desconhecido";
  }
}

function parseFfmpegTime(timeStr: string): number {
  const parts = timeStr.trim().split(":");
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return 0;
}

function safeJobId(value: string | null): string {
  return value && /^[a-zA-Z0-9-]{1,64}$/.test(value) ? value : randomUUID();
}

function safeFps(value: string | null): number {
  const parsed = Number.parseInt(value || "30", 10);
  return [24, 30, 60].includes(parsed) ? parsed : 30;
}

/**
 * Transcodifica um arquivo WebM para MP4 usando o binário nativo do FFmpeg.
 * Utiliza o preset ultrafast com multicore real (threads 0) e relata o progresso
 * segundo a segundo para a interface do usuário.
 */
export async function transcodeWebMToMp4Server(
  inputPath: string,
  outputPath: string,
  fps = 30,
  onProgress?: (info: { timeSec: number; fps: number; speed: string }) => void,
): Promise<void> {
  const binary = getFfmpegPath();
  if (!binary) {
    throw new Error("FFmpeg nativo não está instalado ou acessível no servidor.");
  }

  // Argumentos otimizados para máxima performance e compatibilidade
  const args = [
    "-y",
    "-fflags",
    "+genpts+discardcorrupt",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    `fps=${fps}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-threads",
    "0",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  return new Promise<void>((resolve, reject) => {
    console.log(`[FFmpeg] Iniciando transcodificação: ${inputPath} -> ${outputPath}`);
    const proc = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      // Extrai tempo, fps e velocidade em tempo real
      const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      const fpsMatch = text.match(/fps=\s*([\d.]+)/);
      const speedMatch = text.match(/speed=\s*([\d.]+x)/);

      if (timeMatch) {
        const timeSec = parseFfmpegTime(timeMatch[1]);
        const currentFps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
        const currentSpeed = speedMatch ? speedMatch[1] : "1x";
        onProgress?.({ timeSec, fps: currentFps, speed: currentSpeed });
      }
    });

    proc.on("error", (err) => {
      console.error("[FFmpeg] Erro ao iniciar processo:", err);
      reject(new Error(`Falha ao iniciar processo do FFmpeg: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`[FFmpeg] Transcodificação concluída com sucesso!`);
        resolve();
      } else {
        const lastLines = stderr.split("\n").slice(-8).join("\n");
        console.error(`[FFmpeg] Falha com código ${code}:`, lastLines);
        reject(new Error(`FFmpeg falhou com código ${code}:\n${lastLines}`));
      }
    });
  });
}

/**
 * Middleware para servidor de desenvolvimento (Vite dev server / Node HTTP).
 */
export async function handleNodeTranscodeMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  // Endpoint de status geral
  if (url.pathname === "/api/transcode/status" && req.method === "GET") {
    const available = isFfmpegAvailable();
    const version = available ? getFfmpegVersion() : null;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ available, version, platform: process.platform }));
    return;
  }

  // Endpoint de consulta de progresso do job ativo
  if (url.pathname === "/api/transcode/progress" && req.method === "GET") {
    const id = url.searchParams.get("id");
    const job = id ? activeJobs.get(id) : null;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(job || { status: "not_found" }));
    return;
  }

  // Endpoint de transcodificação
  if (url.pathname === "/api/transcode" && req.method === "POST") {
    if (!isFfmpegAvailable()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "FFmpeg não está disponível no servidor.",
        }),
      );
      return;
    }

    const id = safeJobId(url.searchParams.get("id"));
    const fps = safeFps(url.searchParams.get("fps"));
    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `video-in-${id}.webm`);
    const outputPath = path.join(tempDir, `video-out-${id}.mp4`);

    activeJobs.set(id, {
      status: "uploading",
      timeSec: 0,
      fps: 0,
      speed: "0x",
    });

    try {
      console.log(`[transcode-service] Recebendo upload do vídeo job=${id}...`);
      const writeStream = createWriteStream(inputPath);
      await pipeline(req, writeStream);

      const stat = await fs.stat(inputPath);
      console.log(
        `[transcode-service] Upload concluído! Tamanho: ${(stat.size / 1024 / 1024).toFixed(1)} MB. Iniciando FFmpeg...`,
      );

      activeJobs.set(id, {
        status: "encoding",
        timeSec: 0,
        fps: 0,
        speed: "1x",
      });

      // Executa FFmpeg nativo com relatório de progresso
      await transcodeWebMToMp4Server(inputPath, outputPath, fps, (info) => {
        const job = activeJobs.get(id);
        if (job) {
          job.timeSec = info.timeSec;
          job.fps = info.fps;
          job.speed = info.speed;
        }
      });

      activeJobs.set(id, {
        status: "done",
        timeSec: 0,
        fps: 0,
        speed: "1x",
      });

      // Lê o MP4 e envia como resposta
      const outStat = await fs.stat(outputPath);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": outStat.size,
        "Content-Disposition": `attachment; filename="video-${Date.now()}.mp4"`,
        "Access-Control-Allow-Origin": "*",
      });

      const readStream = createReadStream(outputPath);
      await pipeline(readStream, res);
      console.log(`[transcode-service] MP4 entregue com sucesso para o cliente!`);
    } catch (err) {
      console.error("[transcode-service] Erro na transcodificação:", err);
      const errMsg = err instanceof Error ? err.message : "Erro desconhecido na conversão.";
      activeJobs.set(id, {
        status: "error",
        timeSec: 0,
        fps: 0,
        speed: "0x",
        error: errMsg,
      });

      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMsg }));
      }
    } finally {
      // Limpeza garantida dos arquivos temporários
      setTimeout(() => {
        activeJobs.delete(id);
      }, 10000);

      await Promise.allSettled([
        fs.unlink(inputPath).catch(() => {}),
        fs.unlink(outputPath).catch(() => {}),
      ]);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

/**
 * Handlers para ambiente Web Request / Response (usados no Nitro / SSR em produção).
 */
export async function handleFetchTranscodeStatus(): Promise<Response> {
  const available = isFfmpegAvailable();
  const version = available ? getFfmpegVersion() : null;
  return new Response(
    JSON.stringify({
      available,
      version,
      platform: process.platform,
      diagnostic: getFfmpegDiagnostic(),
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export async function handleFetchTranscodeProgress(url: URL): Promise<Response> {
  const id = url.searchParams.get("id");
  const job = id ? activeJobs.get(id) : null;
  if (id && job) {
    const previous = lastProgressLog.get(id) ?? -10;
    if (job.status !== "encoding" || job.timeSec - previous >= 10) {
      console.log(
        `[render-progress] job=${id} status=${job.status} time=${job.timeSec.toFixed(2)}s`,
      );
      lastProgressLog.set(id, job.timeSec);
    }
  }
  return new Response(JSON.stringify(job || { status: "not_found" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

export function handleFetchRenderEvents(url: URL): Response {
  const id = url.searchParams.get("id") || url.pathname.split("/").filter(Boolean).at(-1) || "";
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let missingTicks = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        const job = activeJobs.get(id);
        if (!job) {
          missingTicks += 1;
          controller.enqueue(encoder.encode("event: waiting\ndata: {}\n\n"));
          if (missingTicks < 60) return;
          if (timer) clearInterval(timer);
          controller.close();
          return;
        }

        missingTicks = 0;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(job)}\n\n`));
        if (job.status === "done" || job.status === "error") {
          if (timer) clearInterval(timer);
          controller.close();
        }
      };

      send();
      timer = setInterval(send, 1000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handleFetchTranscode(request: Request): Promise<Response> {
  if (!isFfmpegAvailable()) {
    return new Response(JSON.stringify({ error: "FFmpeg não está disponível no servidor." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const id = safeJobId(url.searchParams.get("id"));
  const fps = safeFps(url.searchParams.get("fps"));
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `video-in-${id}.webm`);
  const outputPath = path.join(tempDir, `video-out-${id}.mp4`);

  activeJobs.set(id, {
    status: "uploading",
    timeSec: 0,
    fps: 0,
    speed: "0x",
  });

  try {
    if (!request.body) throw new Error("O upload do video chegou vazio ao servidor.");
    const inputFile = await fs.open(inputPath, "w");
    try {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await inputFile.write(value);
      }
    } finally {
      await inputFile.close();
    }

    activeJobs.set(id, {
      status: "encoding",
      timeSec: 0,
      fps: 0,
      speed: "1x",
    });

    await transcodeWebMToMp4Server(inputPath, outputPath, fps, (info) => {
      const job = activeJobs.get(id);
      if (job) {
        job.timeSec = info.timeSec;
        job.fps = info.fps;
        job.speed = info.speed;
      }
    });

    activeJobs.set(id, {
      status: "done",
      timeSec: 0,
      fps: 0,
      speed: "1x",
    });

    const fileBuffer = await fs.readFile(outputPath);
    return new Response(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileBuffer.length.toString(),
        "Content-Disposition": `attachment; filename="video-${Date.now()}.mp4"`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("[transcode-service] Erro no handleFetchTranscode:", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Erro na transcodificação.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    setTimeout(() => {
      activeJobs.delete(id);
    }, 10000);

    await Promise.allSettled([
      fs.unlink(inputPath).catch(() => {}),
      fs.unlink(outputPath).catch(() => {}),
    ]);
  }
}
