interface FFmpegProgressEvent {
  progress: number;
  time: number;
}

interface FFmpegInstance {
  loaded: boolean;
  load: (config: { coreURL: string; wasmURL: string; classWorkerURL?: string }) => Promise<boolean>;
  on: (event: "progress", callback: (event: FFmpegProgressEvent) => void) => void;
  off: (event: "progress", callback: (event: FFmpegProgressEvent) => void) => void;
  writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<boolean>;
  exec: (args: string[]) => Promise<number>;
  terminate: () => void;
}

type FFmpegConstructor = new () => FFmpegInstance;

const FFMPEG_MODULE_URL = "/vendor/ffmpeg/index.js";
const FFMPEG_CORE_URL = "/vendor/ffmpeg/ffmpeg-core.js";
const FFMPEG_WASM_URL = "/vendor/ffmpeg/ffmpeg-core.wasm";

/** Limite máximo de espera para o servidor (5 minutos) */
const SERVER_TRANSCODE_TIMEOUT_MS = 5 * 60 * 1000;

/** Limite máximo de espera para FFmpeg WASM no navegador (60 segundos) */
const WASM_TRANSCODE_TIMEOUT_MS = 60 * 1000;

export interface ServerTranscodeStatus {
  available: boolean;
  version?: string | null;
  platform?: string;
}

/**
 * Consulta se o servidor possui FFmpeg nativo instalado e disponível.
 */
export async function checkServerTranscodeStatus(): Promise<ServerTranscodeStatus> {
  try {
    const res = await fetch("/api/transcode/status", { method: "GET" });
    if (res.ok) {
      return (await res.json()) as ServerTranscodeStatus;
    }
  } catch {
    // Servidor offline ou rota indisponível
  }
  return { available: false };
}

/**
 * Transcodifica WebM para MP4 no SERVIDOR via FFmpeg nativo com aceleração multicore.
 *
 * É o método recomendado:
 * - Não sobrecarrega a RAM do Chrome (evita OOM de 500MB em WASM)
 * - Utiliza CPU nativa com threads reais (AVX2)
 * - Converte vídeos de 8+ minutos em ~10 a 25 segundos
 * - Fornece progresso real de upload e processamento
 */
export async function transcodeViaServer(
  blob: Blob,
  fps = 30,
  duration = 0,
  onProgress?: (progress: number, label?: string) => void,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const id = crypto.randomUUID();
    const xhr = new XMLHttpRequest();
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    xhr.open("POST", `/api/transcode?id=${id}&fps=${fps}`, true);
    xhr.responseType = "blob";
    xhr.timeout = SERVER_TRANSCODE_TIMEOUT_MS;

    // 1. Progresso do envio (0% a 25% da barra de transcodificação)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const uploadFraction = event.loaded / event.total;
        onProgress?.(
          uploadFraction * 0.25,
          `Enviando vídeo para o servidor (${Math.round(uploadFraction * 100)}%)...`,
        );
      }
    };

    // 2. Quando o upload conclui, consulta o progresso real do FFmpeg a cada 600ms
    xhr.upload.onload = () => {
      onProgress?.(0.25, "Iniciando FFmpeg nativo multicore no servidor...");

      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/transcode/progress?id=${id}`);
          if (!res.ok) return;
          const data = await res.json();
          if (data && data.status === "encoding") {
            const timeSec = data.timeSec || 0;
            const fraction = duration > 0 ? Math.min(0.99, timeSec / duration) : 0.5;
            // Mapeia 0.25 a 0.98 da transcodificação
            const mappedProgress = 0.25 + fraction * 0.73;
            const label =
              data.fps > 0
                ? `Codificando no FFmpeg: ${Math.round(mappedProgress * 100)}% (${data.fps} FPS, vel: ${data.speed})`
                : `Codificando no FFmpeg (${Math.round(mappedProgress * 100)}%)...`;
            onProgress?.(mappedProgress, label);
          }
        } catch {
          // ignora falhas esporádicas de rede no polling
        }
      }, 600);
    };

    // 3. Sucesso da transcodificação
    xhr.onload = () => {
      if (pollInterval) clearInterval(pollInterval);
      if (xhr.status >= 200 && xhr.status < 300) {
        const responseBlob = xhr.response as Blob;
        if (responseBlob && responseBlob.size > 0) {
          onProgress?.(1.0, "Conversão finalizada com sucesso!");
          resolve(responseBlob);
        } else {
          reject(new Error("O servidor retornou um MP4 vazio."));
        }
      } else {
        reject(
          new Error(
            `Servidor de transcodificação retornou erro HTTP ${xhr.status}.`,
          ),
        );
      }
    };

    // 4. Tratamento de erros e tempo limite
    xhr.onerror = () => {
      if (pollInterval) clearInterval(pollInterval);
      reject(new Error("Falha na conexão com o servidor de transcodificação."));
    };

    xhr.ontimeout = () => {
      if (pollInterval) clearInterval(pollInterval);
      reject(
        new Error(
          "A conversão no servidor excedeu o tempo limite de segurança.",
        ),
      );
    };

    xhr.send(blob);
  });
}

let ffmpegPromise: Promise<FFmpegInstance> | null = null;

async function getFFmpeg(): Promise<FFmpegInstance> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const moduleUrl = new URL(FFMPEG_MODULE_URL, window.location.href).href;
      const ffmpegModule = (await import(/* @vite-ignore */ moduleUrl)) as unknown as {
        FFmpeg: FFmpegConstructor;
      };
      const ffmpeg = new ffmpegModule.FFmpeg();
      await ffmpeg.load({
        coreURL: FFMPEG_CORE_URL,
        wasmURL: FFMPEG_WASM_URL,
      });
      return ffmpeg;
    })().catch((error) => {
      ffmpegPromise = null;
      throw error;
    });
  }
  return ffmpegPromise;
}

/**
 * Fallback para vídeos pequenos (< 30s) usando FFmpeg WASM diretamente no navegador.
 * Possui proteções de timeout e tratamento de OOM.
 */
export async function transcodeWebMToMp4(
  input: Blob,
  fps: number,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  let ffmpeg: FFmpegInstance;
  try {
    ffmpeg = await getFFmpeg();
  } catch (loadErr) {
    console.error("[transcode] FFmpeg WASM falhou ao carregar:", loadErr);
    throw new Error(
      "O FFmpeg WASM não pôde ser carregado no navegador.",
    );
  }

  const suffix = crypto.randomUUID();
  const inputName = `input-${suffix}.webm`;
  const outputName = `output-${suffix}.mp4`;

  let lastProgressAt = performance.now();
  let lastReportedProgress = 0;

  const handleProgress = ({ progress }: FFmpegProgressEvent) => {
    lastProgressAt = performance.now();
    if (Number.isFinite(progress)) {
      const clamped = Math.max(0, Math.min(1, progress));
      if (clamped > lastReportedProgress) {
        lastReportedProgress = clamped;
        onProgress?.(clamped);
      }
    }
  };

  ffmpeg.on("progress", handleProgress);

  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let timedOut = false;

  // Inicia o watchdog imediatamente para evitar trava durante writeFile
  watchdogTimer = setInterval(() => {
    if (performance.now() - lastProgressAt > WASM_TRANSCODE_TIMEOUT_MS) {
      timedOut = true;
      try {
        ffmpeg.terminate();
      } catch {
        /* best effort */
      }
      ffmpegPromise = null;
    }
  }, 500);

  try {
    const arrayBuf = await input.arrayBuffer();
    const inputData = new Uint8Array(arrayBuf);

    await ffmpeg.writeFile(inputName, inputData);

    const exitCode = await ffmpeg.exec([
      "-fflags",
      "+genpts",
      "-i",
      inputName,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
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
      "-af",
      "aresample=async=1:first_pts=0",
      "-movflags",
      "+faststart",
      "-shortest",
      outputName,
    ]);

    if (timedOut) {
      throw new Error("FFmpeg WASM excedeu o tempo limite.");
    }

    if (exitCode !== 0) {
      throw new Error(`FFmpeg WASM finalizou com erro (código ${exitCode}).`);
    }

    const data = await ffmpeg.readFile(outputName);
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      throw new Error("FFmpeg WASM retornou dados vazios.");
    }

    onProgress?.(1);
    return new Blob([data], { type: "video/mp4" });
  } finally {
    if (watchdogTimer !== null) clearInterval(watchdogTimer);
    ffmpeg.off("progress", handleProgress);
    await Promise.allSettled([
      ffmpeg.deleteFile(inputName),
      ffmpeg.deleteFile(outputName),
    ]).catch(() => {});
  }
}
