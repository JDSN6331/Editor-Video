import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { activeJobs, getFfmpegPath } from "./transcode-service";

/**
 * Montagem de vídeo 100% no servidor (FFmpeg nativo).
 *
 * Fluxo (pensado para vídeos de 8–10 minutos, sem carregar nada pesado no navegador):
 *   1. POST /api/render/upload  → o navegador envia cada mídia (imagem/áudio) em disco;
 *   2. POST /api/render         → inicia o job em segundo plano e responde 202 na hora;
 *   3. GET  /api/render/progress→ o navegador consulta o progresso real do FFmpeg;
 *   4. GET  /api/render/result  → o vídeo pronto é entregue por streaming (com Range);
 *   5. POST /api/render/cancel  → interrompe o FFmpeg e limpa os arquivos temporários.
 *
 * A montagem NÃO fica presa a uma única requisição HTTP, então proxies/CDNs com
 * timeout (Traefik/Easypanel, Cloudflare, Nginx...) não derrubam renders longos.
 */

interface CaptionInput {
  start: number;
  end: number;
  text: string;
}

type MotionEffect = "ken-burns" | "zoom" | "pan" | "dissolve" | "zoom-out";

interface RenderMetadata {
  width: number;
  height: number;
  fps: number;
  duration: number;
  musicVolume: number;
  narrationVolume: number;
  kenBurns: boolean;
  motionEffect: MotionEffect;
  fade: number;
  format: "mp4" | "webm";
  captions: CaptionInput[] | null;
}

interface RenderJob {
  id: string;
  workDir: string;
  outputPath: string | null;
  format: "mp4" | "webm";
  cancelled: boolean;
  proc: ChildProcess | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, RenderJob>();

/** Tempo que o vídeo pronto fica disponível para visualizar/baixar. */
const RESULT_TTL_HOURS = Math.max(1, Number(process.env["RENDER_RESULT_TTL_HOURS"] || 24));
const RESULT_TTL_MS = RESULT_TTL_HOURS * 60 * 60 * 1000;
/** Tempo que uploads órfãos (render nunca iniciado) permanecem no disco. */
const ORPHAN_TTL_MS = 3 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;

/** Pesos de cada etapa na barra de progresso global (somam 1). */
const SEGMENTS_WEIGHT = 0.6;
const CONCAT_WEIGHT = 0.02;

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };
const RENDER_ROOT = process.env["RENDER_DATA_DIR"] || os.tmpdir();

export interface DriveUploadState {
  status: "uploading" | "done" | "error";
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  webViewLink?: string;
  folderName?: string;
  error?: string;
}

const driveUploads = new Map<string, DriveUploadState>();
const cancelledDriveUploads = new Set<string>();
const DRIVE_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const GOOGLE_REQUEST_TIMEOUT_MS = 120_000;

async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("O Google Drive não respondeu em até 2 minutos.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJobId(value: string | null): string {
  return value && /^[a-zA-Z0-9-]{1,64}$/.test(value) ? value : randomUUID();
}

function uploadDirectory(id: string): string {
  return path.join(RENDER_ROOT, `studio-render-upload-${id}`);
}

function resultManifestPath(id: string): string {
  return path.join(uploadDirectory(id), "result.json");
}

/** Aceita apenas nomes gerados pelo próprio upload (evita path traversal). */
function safeStoredName(value: unknown): string | null {
  return typeof value === "string" &&
    /^(?:image-\d{1,4}|narration|music)\.[a-z0-9]{1,6}$/.test(value)
    ? value
    : null;
}

let sweeperStarted = false;

/** Remove diretórios temporários antigos (uploads abandonados e resultados expirados). */
async function sweepStaleDirectories(): Promise<void> {
  const root = RENDER_ROOT;
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  const now = Date.now();
  for (const entry of entries) {
    const match = /^studio-render(?:-upload)?-(.+)$/.exec(entry);
    if (!match) continue;
    const running = [...jobs.values()].some(
      (job) => entry.endsWith(job.id) && activeJobs.get(job.id)?.status === "encoding",
    );
    if (running) continue;
    const fullPath = path.join(root, entry);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    if (now - stat.mtimeMs > Math.min(RESULT_TTL_MS, ORPHAN_TTL_MS)) {
      await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function ensureSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  void sweepStaleDirectories();
  const timer = setInterval(() => void sweepStaleDirectories(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

function parseDeclaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");
  const value = header ? Number(header) : NaN;
  return Number.isFinite(value) ? value : null;
}

export async function saveUploadStream(
  rawId: string | null,
  kind: string,
  index: number,
  originalName: string,
  stream: NodeJS.ReadableStream,
  declaredLength: number | null,
): Promise<{ fileName: string; size: number }> {
  ensureSweeper();
  const safeId = safeJobId(rawId);
  if (!["image", "narration", "music"].includes(kind)) {
    throw new Error("Tipo de arquivo inválido.");
  }
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (declaredLength !== null && declaredLength > limit) {
    throw new Error(`Arquivo grande demais (limite de ${Math.round(limit / 1024 / 1024)} MB).`);
  }

  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.min(9999, index)) : 0;
  const extension = path.extname(originalName).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,6}$/.test(extension) ? extension : ".bin";
  const fileName =
    kind === "image" ? `image-${safeIndex}${safeExtension}` : `${kind}${safeExtension}`;
  const directory = uploadDirectory(safeId);
  const target = path.join(directory, fileName);

  await fs.mkdir(directory, { recursive: true });
  await pipeline(stream, createWriteStream(target));
  const stat = await fs.stat(target);
  if (declaredLength !== null && stat.size !== declaredLength) {
    await fs.unlink(target).catch(() => {});
    throw new Error("O arquivo chegou incompleto ao servidor. Tente novamente.");
  }
  return { fileName, size: stat.size };
}

export async function handleFetchRenderUpload(request: Request): Promise<Response> {
  ensureSweeper();
  const url = new URL(request.url);
  const id = safeJobId(url.searchParams.get("id"));
  const kind = url.searchParams.get("kind");
  const parsedIndex = Number.parseInt(url.searchParams.get("index") || "0", 10);
  const index = Number.isFinite(parsedIndex) ? Math.max(0, Math.min(9999, parsedIndex)) : 0;
  const originalName = url.searchParams.get("name") || "asset.bin";
  if (!request.body || !["image", "narration", "music"].includes(kind || "")) {
    return Response.json({ error: "Upload inválido." }, { status: 400 });
  }

  const declared = parseDeclaredLength(request);
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (declared !== null && declared > limit) {
    return Response.json(
      { error: `Arquivo grande demais (limite de ${Math.round(limit / 1024 / 1024)} MB).` },
      { status: 413 },
    );
  }

  const extension = path.extname(originalName).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,6}$/.test(extension) ? extension : ".bin";
  const fileName = kind === "image" ? `image-${index}${safeExtension}` : `${kind}${safeExtension}`;
  const directory = uploadDirectory(id);
  const target = path.join(directory, fileName);
  try {
    await fs.mkdir(directory, { recursive: true });
    const buffer = Buffer.from(await request.arrayBuffer());
    await fs.writeFile(target, buffer);
    const stat = await fs.stat(target);
    if (declared !== null && stat.size !== declared) {
      throw new Error("O arquivo chegou incompleto ao servidor. Tente novamente.");
    }
    return Response.json(
      { fileName, size: stat.size },
      { headers: { "Cache-Control": "no-store", ...CORS_HEADERS } },
    );
  } catch (error) {
    await fs.unlink(target).catch(() => {});
    const message = error instanceof Error ? error.message : "Falha ao receber arquivo.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function validateMetadata(raw: unknown): RenderMetadata {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const width = numberInRange(input["width"], 1920, 320, 1920);
  const height = numberInRange(input["height"], 1080, 180, 1080);
  const fps = [24, 30, 60].includes(Number(input["fps"])) ? Number(input["fps"]) : 30;
  const rawCaptions = Array.isArray(input["captions"]) ? input["captions"] : [];
  const captionDuration = rawCaptions.reduce((largest, item) => {
    const end = Number((item as Record<string, unknown>)?.["end"]);
    return Number.isFinite(end) ? Math.max(largest, end) : largest;
  }, 0);
  const duration = numberInRange(input["duration"], captionDuration, 0.1, 3600);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Duração inválida para a montagem. Recarregue a narração e tente novamente.");
  }
  const captions = rawCaptions
    .slice(0, 5000)
    .map((item) => {
      const caption = item as Record<string, unknown>;
      return {
        start: numberInRange(caption["start"], 0, 0, duration),
        end: numberInRange(caption["end"], 0, 0, duration),
        text: String(caption["text"] || "").slice(0, 1000),
      };
    })
    .filter((caption) => caption.text && caption.end > caption.start);
  const requestedEffect = String(input["motionEffect"] || "");
  const motionEffect: MotionEffect = ["ken-burns", "zoom", "pan", "dissolve", "zoom-out"].includes(
    requestedEffect,
  )
    ? (requestedEffect as MotionEffect)
    : input["kenBurns"] === false
      ? "dissolve"
      : "ken-burns";
  return {
    width: Math.round(width / 2) * 2,
    height: Math.round(height / 2) * 2,
    fps,
    duration,
    musicVolume: numberInRange(input["musicVolume"], 0.15, 0, 1),
    narrationVolume: numberInRange(input["narrationVolume"], 1, 0, 1),
    kenBurns: input["kenBurns"] !== false,
    motionEffect,
    fade: numberInRange(input["fade"], 0.6, 0, 1.5),
    format: input["format"] === "webm" ? "webm" : "mp4",
    captions,
  };
}

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const whole = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function assText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function buildAss(
  captions: CaptionInput[],
  width: number,
  height: number,
): {
  background: string;
  text: string;
} {
  const fontSize = Math.round(height * 0.055);
  const marginV = Math.round(height * 0.075);
  const backgroundEvents: string[] = [];
  const textEvents: string[] = [];
  for (const caption of captions) {
    const words = caption.text.trim().split(/\s+/).filter(Boolean);
    const totalCs = Math.max(1, Math.round((caption.end - caption.start) * 100));
    const totalChars = Math.max(
      1,
      words.reduce((sum, word) => sum + word.length, 0),
    );
    let used = 0;
    const karaoke = words
      .map((word, index) => {
        const remaining = totalCs - used;
        const duration =
          index === words.length - 1
            ? Math.max(1, remaining)
            : Math.max(1, Math.round((totalCs * word.length) / totalChars));
        used += duration;
        // Palavra por palavra acompanha melhor o ritmo do que a varredura
        // contínua do karaoke \kf.
        return `{\\k${duration}}${assText(word)}`;
      })
      .join(" ");
    const start = assTime(caption.start);
    const end = assTime(caption.end);
    backgroundEvents.push(
      `Dialogue: 0,${start},${end},Background,,0,0,0,,${assText(caption.text)}`,
    );
    const opaqueText = "{\\alpha&H00&\\1c&H3FD2FF&\\2c&HFFFFFF&}";
    textEvents.push(`Dialogue: 0,${start},${end},Text,,0,0,0,,${opaqueText}${karaoke}`);
  }

  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;
  const eventHeader = `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  return {
    background: `${header}Style: Background,DejaVu Sans,${fontSize},&HFF000000,&HFF000000,&H50505050,&H50505050,-1,0,0,0,100,100,0,0,3,3,0,2,80,80,${marginV},1\n${eventHeader}${backgroundEvents.join("\n")}\n`,
    text: `${header}Style: Text,DejaVu Sans,${fontSize},&H003FD2FF,&H00FFFFFF,&H00101010,&HFF000000,-1,0,0,0,100,100,0,0,1,3,0,2,80,80,${marginV},1\n${eventHeader}${textEvents.join("\n")}\n`,
  };
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

class CancelledError extends Error {
  constructor() {
    super("CANCELLED");
  }
}

/**
 * Executa o FFmpeg lendo o progresso por `-progress pipe:1` (formato estável e
 * legível por máquina) e deixando o stderr limpo apenas para mensagens de erro.
 */
async function runFfmpeg(
  args: string[],
  job: RenderJob,
  onSeconds?: (seconds: number) => void,
): Promise<void> {
  const binary = getFfmpegPath();
  if (!binary) throw new Error("FFmpeg nativo não está disponível no servidor.");
  if (job.cancelled) throw new CancelledError();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      binary,
      ["-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1", ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    job.proc = proc;
    let stderr = "";
    let stdoutBuffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        // Apesar do nome, out_time_ms também vem em microssegundos.
        const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (match && onSeconds) onSeconds(Number(match[1]) / 1_000_000);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16000);
    });
    proc.on("error", (error) => reject(new Error(`Falha ao iniciar FFmpeg: ${error.message}`)));
    proc.on("close", (code) => {
      job.proc = null;
      if (job.cancelled) reject(new CancelledError());
      else if (code === 0) resolve();
      else
        reject(
          new Error(`FFmpeg falhou (${code}): ${stderr.trim().split("\n").slice(-10).join("\n")}`),
        );
    });
  });
}

function setProgress(id: string, fraction: number, duration: number, patch = {}) {
  const job = activeJobs.get(id);
  if (!job) return;
  // Nunca recua: o FFmpeg pode reportar tempos levemente fora de ordem.
  const next = Math.max(job.progress ?? 0, Math.min(0.995, fraction));
  Object.assign(job, patch, { progress: next, timeSec: next * duration });
}

async function disposeJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (job?.cleanupTimer) clearTimeout(job.cleanupTimer);
  jobs.delete(id);
  await fs
    .rm(job?.workDir ?? uploadDirectory(id), { recursive: true, force: true })
    .catch(() => {});
}

interface RenderPlan {
  metadata: RenderMetadata;
  imagePaths: string[];
  narrationPath: string;
  musicPath: string | null;
}

async function runRenderJob(job: RenderJob, plan: RenderPlan): Promise<void> {
  const { id, workDir } = job;
  const { metadata, imagePaths, narrationPath, musicPath } = plan;
  const hasCaptions = Boolean(metadata.captions?.length);
  const captionBackgroundPath = path.join(workDir, "captions-background.ass");
  const captionTextPath = path.join(workDir, "captions-text.ass");
  if (hasCaptions) {
    const ass = buildAss(metadata.captions!, metadata.width, metadata.height);
    await Promise.all([
      fs.writeFile(captionBackgroundPath, ass.background, "utf8"),
      fs.writeFile(captionTextPath, ass.text, "utf8"),
    ]);
  }
  const outputPath = path.join(workDir, metadata.format === "webm" ? "output.webm" : "output.mp4");

  const finalWeight = 1 - SEGMENTS_WEIGHT - CONCAT_WEIGHT;
  const perImage = metadata.duration / imagePaths.length;
  // A superfície 2x reduz o arredondamento do zoompan que fazia o centro
  // oscilar entre pixels e dava a impressão de imagem tremendo.
  const scaledWidth = metadata.width * 3;
  const scaledHeight = metadata.height * 3;
  const frames = Math.max(1, Math.ceil(perImage * metadata.fps));
  const segmentPaths: string[] = [];
  console.log(
    `[render-service] job=${id} iniciando ${imagePaths.length} segmentos em ${metadata.width}x${metadata.height}@${metadata.fps}`,
  );

  for (let index = 0; index < imagePaths.length; index += 1) {
    const segmentPath = path.join(workDir, `segment-${String(index).padStart(3, "0")}.mp4`);
    const base = `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,crop=${scaledWidth}:${scaledHeight}`;
    const frameDivisor = Math.max(1, frames - 1);
    const smooth = `(3*(on/${frameDivisor})*(on/${frameDivisor})-2*(on/${frameDivisor})*(on/${frameDivisor})*(on/${frameDivisor}))`;
    const zoompan = (z: string, x: string, y: string) =>
      `,zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${metadata.width}x${metadata.height}:fps=${metadata.fps}`;
    const motion =
      metadata.motionEffect === "ken-burns"
        ? zoompan(
            `1.035+0.025*${smooth}`,
            `(iw-iw/zoom)*(0.2+0.6*${smooth})`,
            `(ih-ih/zoom)*(0.3+0.4*${smooth})`,
          )
        : metadata.motionEffect === "zoom"
          ? zoompan(`1+0.025*${smooth}`, "(iw-iw/zoom)/2", "(ih-ih/zoom)/2")
          : metadata.motionEffect === "zoom-out"
            ? zoompan(`1.025-0.025*${smooth}`, "(iw-iw/zoom)/2", "(ih-ih/zoom)/2")
            : metadata.motionEffect === "pan"
              ? zoompan("1.06", `(iw-iw/zoom)*${smooth}`, "(ih-ih/zoom)/2")
              : `,scale=${metadata.width}:${metadata.height}`;
    const detail = `Cena ${index + 1} de ${imagePaths.length}`;
    const commonInput = [
      "-y",
      "-loop",
      "1",
      "-framerate",
      String(metadata.fps),
      "-i",
      imagePaths[index]!,
    ];
    const canDissolve = metadata.motionEffect === "dissolve" && index < imagePaths.length - 1;
    const dissolveDuration = Math.max(0.1, Math.min(metadata.fade, perImage / 3));
    const segmentArgs = canDissolve
      ? [
          ...commonInput,
          "-loop",
          "1",
          "-framerate",
          String(metadata.fps),
          "-i",
          imagePaths[index + 1]!,
          "-filter_complex",
          `[0:v]${base},scale=${metadata.width}:${metadata.height},setsar=1,format=yuv420p[cur];[1:v]${base},scale=${metadata.width}:${metadata.height},setsar=1,format=yuv420p[next];[cur][next]xfade=transition=fade:duration=${dissolveDuration}:offset=${Math.max(0, perImage - dissolveDuration)}[out]`,
          "-map",
          "[out]",
        ]
      : [...commonInput, "-vf", `${base}${motion},setsar=1,format=yuv420p`];
    segmentArgs.push(
      "-frames:v",
      String(frames),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "0",
      segmentPath,
    );
    setProgress(id, (index / imagePaths.length) * SEGMENTS_WEIGHT, metadata.duration, {
      stage: "segments",
      detail,
    });
    await runFfmpeg(segmentArgs, job, (seconds) => {
      const within = Math.min(1, seconds / perImage);
      setProgress(id, ((index + within) / imagePaths.length) * SEGMENTS_WEIGHT, metadata.duration, {
        detail,
      });
    });
    segmentPaths.push(segmentPath);
    console.log(`[render-service] job=${id} segmento ${index + 1}/${imagePaths.length} concluído`);
  }

  setProgress(id, SEGMENTS_WEIGHT, metadata.duration, {
    stage: "concat",
    detail: "Unindo as cenas",
  });
  const concatListPath = path.join(workDir, "segments.txt");
  const concatList = segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(concatListPath, `${concatList}\n`, "utf8");
  const visualsPath = path.join(workDir, "visuals.mp4");
  await runFfmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", visualsPath],
    job,
  );
  // Os segmentos já foram incorporados; libera espaço em disco antes da etapa final.
  await Promise.all(segmentPaths.map((segmentPath) => fs.unlink(segmentPath).catch(() => {})));

  // Sem legendas e em MP4, o vídeo das cenas já está em H.264: basta copiar a imagem
  // e mixar o áudio, o que reduz muito o tempo da etapa final.
  const copyVideo = !hasCaptions && metadata.format === "mp4";
  const args: string[] = ["-y", "-i", visualsPath, "-i", narrationPath];
  if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
  const filters: string[] = [];
  if (hasCaptions) {
    // Dois filtros sequenciais tornam a ordem inequívoca: primeiro a caixa
    // translúcida; depois o texto branco/amarelo totalmente opaco.
    filters.push(`[0:v]subtitles=filename='${escapeFilterPath(captionBackgroundPath)}'[captionbg]`);
    filters.push(`[captionbg]subtitles=filename='${escapeFilterPath(captionTextPath)}'[videoout]`);
  }
  if (musicPath) {
    const fadeStart = Math.max(0, metadata.duration - 2);
    filters.push(`[1:a]volume=${metadata.narrationVolume}[narr]`);
    filters.push(
      `[2:a]volume=${metadata.musicVolume},atrim=0:${metadata.duration},afade=t=out:st=${fadeStart}:d=2[music]`,
    );
    filters.push("[narr][music]amix=inputs=2:duration=first:dropout_transition=0[audioout]");
  } else {
    filters.push(`[1:a]volume=${metadata.narrationVolume}[audioout]`);
  }
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    hasCaptions ? "[videoout]" : "0:v:0",
    "-map",
    "[audioout]",
    "-t",
    String(metadata.duration),
  );
  if (metadata.format === "webm") {
    args.push(
      "-c:v",
      "libvpx-vp9",
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      "-row-mt",
      "1",
      "-b:v",
      "0",
      "-crf",
      "30",
      "-c:a",
      "libopus",
    );
  } else {
    if (copyVideo) {
      args.push("-c:v", "copy");
    } else {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p");
    }
    args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
  }
  args.push("-threads", "0", outputPath);

  console.log(`[render-service] job=${id} aplicando áudio e legendas`);
  const finalBase = SEGMENTS_WEIGHT + CONCAT_WEIGHT;
  setProgress(id, finalBase, metadata.duration, {
    stage: "final",
    detail: hasCaptions ? "Aplicando áudio e legendas" : "Aplicando áudio",
  });
  await runFfmpeg(args, job, (seconds) => {
    setProgress(
      id,
      finalBase + Math.min(1, seconds / metadata.duration) * finalWeight,
      metadata.duration,
    );
  });

  const stat = await fs.stat(outputPath);
  if (!stat.size) throw new Error("O FFmpeg gerou um vídeo vazio.");
  job.outputPath = outputPath;
  await fs.writeFile(
    resultManifestPath(id),
    JSON.stringify({ format: metadata.format, size: stat.size, completedAt: Date.now() }),
    "utf8",
  );
  // Mantém só o necessário para entregar o vídeo.
  await Promise.all(
    [
      visualsPath,
      concatListPath,
      ...imagePaths,
      narrationPath,
      ...(musicPath ? [musicPath] : []),
    ].map((file) => fs.unlink(file).catch(() => {})),
  );
  activeJobs.set(id, {
    status: "done",
    timeSec: metadata.duration,
    fps: metadata.fps,
    speed: "1x",
    progress: 1,
    stage: "done",
    detail: "Vídeo pronto",
    outputSize: stat.size,
  });
  console.log(`[render-service] job=${id} concluído (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  job.cleanupTimer = setTimeout(() => void disposeJob(id), RESULT_TTL_MS);
  job.cleanupTimer.unref?.();
}

async function startJobInBackground(job: RenderJob, plan: RenderPlan): Promise<void> {
  try {
    await runRenderJob(job, plan);
  } catch (error) {
    if (error instanceof CancelledError || job.cancelled) {
      activeJobs.set(job.id, {
        status: "error",
        timeSec: 0,
        fps: 0,
        speed: "0x",
        error: "CANCELLED",
      });
    } else {
      const message = error instanceof Error ? error.message : "Falha na montagem do vídeo.";
      console.error("[render-service]", error);
      activeJobs.set(job.id, { status: "error", timeSec: 0, fps: 0, speed: "0x", error: message });
    }
    await disposeJob(job.id);
    // Mantém o estado de erro visível por um instante para quem consulta o progresso.
    setTimeout(() => activeJobs.delete(job.id), 60_000).unref?.();
  }
}

/** Inicia a montagem em segundo plano e retorna o identificador do job. */
export async function startRenderJob(
  rawId: string | null,
  body: {
    metadata?: unknown;
    images?: unknown;
    narration?: unknown;
    music?: unknown;
  } | null,
): Promise<{ id: string }> {
  ensureSweeper();
  const binary = getFfmpegPath();
  if (!binary) throw new Error("FFmpeg não disponível no servidor.");
  const id = safeJobId(rawId);
  const existing = jobs.get(id);
  if (existing && activeJobs.get(id)?.status === "encoding") {
    throw new Error("Esta montagem já está em andamento.");
  }

  if (!body) throw new Error("Pedido de montagem inválido.");
  const metadata = validateMetadata(body.metadata);

  const workDir = uploadDirectory(id);
  const dirStat = await fs.stat(workDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error("Os arquivos enviados não foram encontrados no servidor. Tente novamente.");
  }

  const imageNames = Array.isArray(body.images) ? body.images : [];
  if (!imageNames.length) throw new Error("Nenhuma imagem foi recebida pelo servidor.");
  if (imageNames.length > 200) throw new Error("O limite é de 200 imagens por vídeo.");
  const imagePaths: string[] = [];
  for (const name of imageNames) {
    const stored = safeStoredName(name);
    if (!stored) throw new Error("Nome de imagem inválido no pedido de montagem.");
    const filePath = path.join(workDir, stored);
    await fs.access(filePath).catch(() => {
      throw new Error(`A imagem ${stored} não chegou ao servidor.`);
    });
    imagePaths.push(filePath);
  }

  const storedNarration = safeStoredName(body.narration);
  if (!storedNarration) throw new Error("A narração não foi recebida pelo servidor.");
  const narrationPath = path.join(workDir, storedNarration);
  await fs.access(narrationPath).catch(() => {
    throw new Error("A narração não chegou ao servidor.");
  });

  let musicPath: string | null = null;
  if (body.music) {
    const storedMusic = safeStoredName(body.music);
    if (!storedMusic) throw new Error("Nome de música inválido no pedido de montagem.");
    musicPath = path.join(workDir, storedMusic);
    await fs.access(musicPath).catch(() => {
      throw new Error("A música não chegou ao servidor.");
    });
  }

  const job: RenderJob = {
    id,
    workDir,
    outputPath: null,
    format: metadata.format,
    cancelled: false,
    proc: null,
    cleanupTimer: null,
  };
  jobs.set(id, job);
  activeJobs.set(id, {
    status: "encoding",
    timeSec: 0,
    fps: 0,
    speed: "1x",
    progress: 0,
    stage: "segments",
    detail: "Iniciando montagem",
  });
  void startJobInBackground(job, { metadata, imagePaths, narrationPath, musicPath });
  return { id };
}

/** Inicia a montagem em segundo plano e responde imediatamente (202). */
export async function handleFetchRender(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get("id");
    const body = (await request.json().catch(() => null)) as {
      metadata?: unknown;
      images?: unknown;
      narration?: unknown;
      music?: unknown;
    } | null;
    const result = await startRenderJob(id, body);
    return Response.json(result, { status: 202, headers: CORS_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao iniciar a montagem.";
    console.error("[render-service]", error);
    return Response.json({ error: message }, { status: 400 });
  }
}

export function sanitizeDownloadName(value: string | null | undefined, extension: string): string {
  const cleaned = (value || "video")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleaned || "video"}.${extension}`;
}

async function recoverCompletedJob(id: string): Promise<RenderJob | null> {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) return null;
  const directory = uploadDirectory(id);
  const manifest = await fs
    .readFile(resultManifestPath(id), "utf8")
    .then((value) => JSON.parse(value) as { format?: unknown; completedAt?: unknown })
    .catch(() => null);

  let format: "mp4" | "webm" | null =
    manifest?.format === "webm" ? "webm" : manifest?.format === "mp4" ? "mp4" : null;
  let outputPath = format ? path.join(directory, `output.${format}`) : "";
  let stat = outputPath ? await fs.stat(outputPath).catch(() => null) : null;

  if (!stat?.isFile() || !stat.size) {
    // Compatibilidade com resultados gerados antes da criação do manifesto.
    // Só recupera se os arquivos de entrada já tiverem sido removidos, sinal de
    // que a etapa final terminou e não se trata de um MP4 parcial após crash.
    const entries = await fs.readdir(directory).catch(() => [] as string[]);
    const stillHasInputs = entries.some((entry) => /^(?:image-\d+|narration|music)\./i.test(entry));
    if (stillHasInputs) return null;
    const legacyFormat = entries.includes("output.mp4")
      ? "mp4"
      : entries.includes("output.webm")
        ? "webm"
        : null;
    if (!legacyFormat) return null;
    format = legacyFormat;
    outputPath = path.join(directory, `output.${format}`);
    stat = await fs.stat(outputPath).catch(() => null);
    if (!stat?.isFile() || !stat.size) return null;
  }

  const completedAt = Number(manifest?.completedAt) || stat.mtimeMs;
  const age = Math.max(0, Date.now() - completedAt);
  if (age >= RESULT_TTL_MS) return null;

  const recovered: RenderJob = {
    id,
    workDir: directory,
    outputPath,
    format: format!,
    cancelled: false,
    proc: null,
    cleanupTimer: null,
  };
  jobs.set(id, recovered);
  activeJobs.set(id, {
    status: "done",
    timeSec: 0,
    fps: 0,
    speed: "1x",
    progress: 1,
    stage: "done",
    detail: "Vídeo pronto (resultado recuperado)",
    outputSize: stat.size,
  });
  recovered.cleanupTimer = setTimeout(() => void disposeJob(id), RESULT_TTL_MS - age);
  recovered.cleanupTimer.unref?.();
  console.log(`[render-service] job=${id} resultado recuperado do disco`);
  return recovered;
}

export async function getRenderResultInfo(
  rawId: string | null,
  rangeHeader: string | null,
): Promise<{
  path: string;
  format: "mp4" | "webm";
  status: number;
  headers: Record<string, string>;
  start: number;
  end: number;
}> {
  const id = rawId || "";
  ensureSweeper();
  const job = jobs.get(id) ?? (await recoverCompletedJob(id));
  if (!job || !job.outputPath || activeJobs.get(id)?.status !== "done") {
    throw new Error("Vídeo não encontrado. Ele pode ter expirado; monte novamente.");
  }
  const stat = await fs.stat(job.outputPath).catch(() => null);
  if (!stat) {
    throw new Error("O arquivo do vídeo não está mais disponível.");
  }

  const contentType = job.format === "webm" ? "video/webm" : "video/mp4";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  };

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, stat.size - Number(range[2]));
    }
    if (start > end || start >= stat.size) {
      const err = new Error("Range Not Satisfiable") as Error & {
        status?: number;
        rangeHeader?: string;
      };
      err.status = 416;
      err.rangeHeader = `bytes */${stat.size}`;
      throw err;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = String(end - start + 1);

  return {
    path: job.outputPath,
    format: job.format,
    status,
    headers,
    start,
    end,
  };
}

async function googleJson(response: Response, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${context} (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${context}: resposta inválida do Google.`);
  }
}

async function getOrCreateGoogleDriveFolder(
  accessToken: string,
  folderName: string,
): Promise<string> {
  const escapedName = folderName.replace(/'/g, "\\'");
  const query = encodeURIComponent(
    `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const searchResponse = await googleFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&spaces=drive`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const search = await googleJson(searchResponse, "Falha ao buscar a pasta no Google Drive");
  const files = Array.isArray(search["files"])
    ? (search["files"] as Array<Record<string, unknown>>)
    : [];
  const existingId = files[0]?.["id"];
  if (typeof existingId === "string" && existingId) return existingId;

  const createResponse = await googleFetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  const created = await googleJson(createResponse, "Falha ao criar a pasta no Google Drive");
  const createdId = created["id"];
  if (typeof createdId !== "string" || !createdId) {
    throw new Error("O Google Drive não devolveu o ID da pasta criada.");
  }
  return createdId;
}

async function uploadRenderToGoogleDrive(
  id: string,
  accessToken: string,
  fileName: string,
  folderName: string,
): Promise<void> {
  const state = driveUploads.get(id);
  if (!state) return;
  try {
    const info = await getRenderResultInfo(id, null);
    const stat = await fs.stat(info.path);
    state.totalBytes = stat.size;
    const folderId = await getOrCreateGoogleDriveFolder(accessToken, folderName);

    const initResponse = await googleFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": info.headers["Content-Type"] || "video/mp4",
          "X-Upload-Content-Length": String(stat.size),
        },
        body: JSON.stringify({ name: fileName, parents: [folderId] }),
      },
    );
    if (!initResponse.ok) {
      throw new Error(
        `Falha ao iniciar o envio ao Google Drive (HTTP ${initResponse.status}): ${(await initResponse.text()).slice(0, 500)}`,
      );
    }
    const uploadUrl = initResponse.headers.get("location");
    if (!uploadUrl) throw new Error("O Google Drive não devolveu a URL de upload.");

    const file = await fs.open(info.path, "r");
    let finalData: Record<string, unknown> | null = null;
    try {
      let position = 0;
      while (position < stat.size) {
        if (cancelledDriveUploads.has(id)) throw new Error("Upload cancelado.");
        const length = Math.min(DRIVE_UPLOAD_CHUNK_SIZE, stat.size - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        if (bytesRead !== length) {
          throw new Error(`Leitura incompleta do vídeo: ${bytesRead} de ${length} bytes.`);
        }
        const end = position + bytesRead - 1;
        let uploadResponse: Response | null = null;
        let uploadError: unknown = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            uploadResponse = await googleFetch(uploadUrl, {
              method: "PUT",
              redirect: "manual",
              headers: {
                "Content-Type": info.headers["Content-Type"] || "video/mp4",
                "Content-Length": String(bytesRead),
                "Content-Range": `bytes ${position}-${end}/${stat.size}`,
              },
              body: buffer,
            });
            if (uploadResponse.status < 500) break;
            if (attempt < 3) await uploadResponse.body?.cancel();
          } catch (error) {
            uploadError = error;
            uploadResponse = null;
          }
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
        if (!uploadResponse) {
          throw uploadError instanceof Error
            ? uploadError
            : new Error("O Google Drive não respondeu durante o envio.");
        }
        if (uploadResponse.status === 200 || uploadResponse.status === 201) {
          finalData = await googleJson(uploadResponse, "Resposta final inválida do Google Drive");
        } else if (uploadResponse.status !== 308) {
          throw new Error(
            `Falha durante o envio ao Google Drive (HTTP ${uploadResponse.status}): ${(await uploadResponse.text()).slice(0, 500)}`,
          );
        }
        position += bytesRead;
        state.uploadedBytes = position;
        state.progress = Math.min(100, Math.round((position / stat.size) * 100));
      }
    } finally {
      await file.close();
    }

    const fileId = finalData?.["id"];
    if (typeof fileId !== "string" || !fileId) {
      throw new Error("O Google Drive concluiu o envio sem devolver o ID do arquivo.");
    }
    state.status = "done";
    state.progress = 100;
    state.webViewLink = `https://drive.google.com/file/d/${fileId}/view`;
    state.folderName = folderName;
  } catch (error) {
    state.status = "error";
    state.error = error instanceof Error ? error.message : "Falha ao enviar para o Google Drive.";
  }
}

export async function startGoogleDriveUpload(
  id: string,
  accessToken: string,
  fileName: string,
  folderName = "Editor de Vídeo",
): Promise<DriveUploadState> {
  if (!accessToken.trim()) throw new Error("Token do Google não informado.");
  const info = await getRenderResultInfo(id, null);
  const stat = await fs.stat(info.path);
  const current = driveUploads.get(id);
  if (current?.status === "uploading") return current;
  const state: DriveUploadState = {
    status: "uploading",
    progress: 0,
    uploadedBytes: 0,
    totalBytes: stat.size,
  };
  driveUploads.set(id, state);
  cancelledDriveUploads.delete(id);
  void uploadRenderToGoogleDrive(
    id,
    accessToken,
    sanitizeDownloadName(fileName, info.format),
    folderName,
  );
  return state;
}

export function cancelGoogleDriveUpload(id: string): void {
  cancelledDriveUploads.add(id);
  const state = driveUploads.get(id);
  if (state?.status === "uploading") {
    state.status = "error";
    state.error = "Upload cancelado.";
  }
}

export function getGoogleDriveUploadState(id: string): DriveUploadState {
  return (
    driveUploads.get(id) || {
      status: "error",
      progress: 0,
      uploadedBytes: 0,
      totalBytes: 0,
      error: "Envio ao Google Drive não encontrado.",
    }
  );
}

/** Entrega o vídeo pronto por streaming, com suporte a Range (permite buscar no player). */
export async function handleFetchRenderResult(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const isDownload = url.searchParams.get("download") === "1";
  const customFilename = url.searchParams.get("filename");
  const rangeHeader = request.headers.get("range");

  try {
    const info = await getRenderResultInfo(id, rangeHeader);
    const headers = { ...info.headers };
    if (isDownload) {
      headers["Content-Disposition"] =
        `attachment; filename="${sanitizeDownloadName(customFilename, info.format)}"`;
    }

    const stream = createReadStream(info.path, { start: info.start, end: info.end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: info.status,
      headers,
    });
  } catch (error) {
    const statusError = error as { status?: number; rangeHeader?: string };
    if (statusError.status === 416) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": statusError.rangeHeader || "", ...CORS_HEADERS },
      });
    }
    const message = error instanceof Error ? error.message : "Vídeo não encontrado.";
    return Response.json({ error: message }, { status: 404 });
  }
}

/** Cancela a montagem (mata o FFmpeg) e remove os arquivos temporários. */
export async function cancelRenderJob(rawId: string | null): Promise<void> {
  const id = safeJobId(rawId);
  const job = jobs.get(id);
  if (job) {
    job.cancelled = true;
    job.proc?.kill("SIGKILL");
    if (activeJobs.get(id)?.status === "done") {
      await disposeJob(id);
      activeJobs.delete(id);
    }
  } else {
    await fs.rm(uploadDirectory(id), { recursive: true, force: true }).catch(() => {});
  }
}

export async function handleFetchRenderCancel(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  await cancelRenderJob(id);
  return Response.json({ ok: true }, { headers: CORS_HEADERS });
}
