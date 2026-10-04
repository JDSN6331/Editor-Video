import type { Caption, MotionEffect } from "./types";
import { generateId } from "../uuid";

/**
 * Cliente da montagem de vídeo no servidor.
 *
 * O navegador NÃO monta nada: ele só (1) envia as mídias ao servidor, uma por vez
 * (sem manter tudo na memória), (2) pede o início do job de FFmpeg e (3) mostra o
 * progresso real devolvido pelo servidor. O vídeo pronto é reproduzido/baixado
 * direto da URL do servidor, sem carregar centenas de MB no navegador.
 */

interface ServerRenderOptions {
  images: Array<{ name: string; dataUrl?: string; url: string; blob?: Blob }>;
  narration: { name: string; dataUrl?: string; url: string; blob?: Blob };
  music?: { name: string; dataUrl?: string; url: string; blob?: Blob } | null;
  captions: Caption[] | null;
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
  onProgress?: (
    progress: number,
    stage: "preparing" | "uploading" | "encoding",
    detail?: string,
    timeSec?: number,
  ) => void;
  cancelRef?: { cancelled: boolean };
}

export interface ServerRenderResult {
  id: string;
  /** URL do vídeo no servidor (streaming com suporte a Range). */
  url: string;
  size: number;
}

interface RenderProgress {
  status: "uploading" | "encoding" | "done" | "error" | "not_found";
  timeSec?: number;
  progress?: number;
  detail?: string;
  outputSize?: number;
  error?: string;
}

type SourceDescriptor = {
  kind: "image" | "narration" | "music";
  index: number;
  name: string;
  source: string;
  blob?: Blob;
};

// Vazio em desenvolvimento: o Vite encaminha /api ao backend da porta 3001.
// Em producao, use a URL publica do servico de renderizacao no Easypanel.
const API_BASE = String(
  import.meta.env["VITE_RENDER_API_URL"] || import.meta.env["VITE_TRANSCODE_API_URL"] || "",
).replace(/\/$/, "");

/** Fatia da barra de progresso reservada ao envio das mídias; o resto é a montagem. */
const UPLOAD_SHARE = 0.08;
/** Um envio é considerado travado se nada trafegar por este tempo. */
const UPLOAD_STALL_MS = 60_000;
const UPLOAD_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 1000;
/** Quantas consultas seguidas podem falhar (rede/servidor reiniciando) antes de desistir. */
const POLL_MAX_FAILURES = 60;

class NonRetryableError extends Error {}

function dataUrlToBlobFallback(source: string): Blob {
  const separator = source.indexOf(",");
  if (separator < 0) throw new Error("Data URL inválida.");
  const header = source.slice(0, separator);
  const content = source.slice(separator + 1);
  const mimeType = header.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  if (!header.includes(";base64")) {
    return new Blob([decodeURIComponent(content)], { type: mimeType });
  }

  const decoded = atob(content);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function sourceToBlob(source: string, name: string): Promise<Blob> {
  if (source.startsWith("data:")) {
    return dataUrlToBlobFallback(source);
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.blob();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`A preparação de ${name} excedeu 30 segundos.`);
    }
    throw new Error(`Não foi possível preparar ${name}.`);
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Estimativa barata do tamanho (sem decodificar) só para ponderar a barra de progresso. */
function estimateBytes(source: string): number {
  if (!source.startsWith("data:")) return 1_000_000;
  const separator = source.indexOf(",");
  return Math.max(1, Math.floor(((source.length - separator - 1) * 3) / 4));
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `O servidor respondeu com HTTP ${response.status}.`;
  } catch {
    return `O servidor respondeu com HTTP ${response.status}.`;
  }
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function uploadOnce(
  id: string,
  asset: SourceDescriptor,
  blob: Blob,
  onLoaded: (loaded: number) => void,
  cancelRef?: { cancelled: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({
      id,
      kind: asset.kind,
      index: String(asset.index),
      name: asset.name,
    });
    const request = new XMLHttpRequest();
    request.open("POST", `${API_BASE}/api/render/upload?${query}`);
    request.responseType = "json";
    // 3 minutos de limite total por arquivo individual
    request.timeout = 180_000;

    const cancelTimer = window.setInterval(() => {
      if (cancelRef?.cancelled) request.abort();
    }, 200);

    const finish = () => {
      window.clearInterval(cancelTimer);
    };

    request.upload.onprogress = (event) => {
      onLoaded(event.loaded);
    };

    request.onload = () => {
      finish();
      const payload = (request.response || {}) as { fileName?: string; error?: string };
      if (request.status >= 200 && request.status < 300 && payload.fileName) {
        onLoaded(blob.size);
        resolve(payload.fileName);
        return;
      }
      let message = payload.error || `Falha ao enviar ${asset.name} (HTTP ${request.status}).`;
      if (request.status === 413) {
        message = `O servidor recusou ${asset.name} por tamanho (HTTP 413).`;
      }
      if (request.status >= 400 && request.status < 500) {
        reject(new NonRetryableError(message));
      } else {
        reject(new Error(message));
      }
    };

    request.onerror = () => {
      finish();
      reject(new Error(`Falha de conexão ao enviar ${asset.name}.`));
    };

    request.ontimeout = () => {
      finish();
      reject(new Error(`O envio de ${asset.name} excedeu o limite de 3 minutos.`));
    };

    request.onabort = () => {
      finish();
      reject(new NonRetryableError("CANCELLED"));
    };

    request.send(blob);
  });
}

async function uploadAsset(
  id: string,
  asset: SourceDescriptor,
  onLoaded: (loaded: number) => void,
  cancelRef?: { cancelled: boolean },
): Promise<string> {
  // Um Blob por vez: some da memória assim que o envio termina.
  const blob = asset.blob ?? (await sourceToBlob(asset.source, asset.name));
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    if (cancelRef?.cancelled) throw new Error("CANCELLED");
    try {
      onLoaded(0);
      return await uploadOnce(id, asset, blob, onLoaded, cancelRef);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof NonRetryableError || attempt === UPLOAD_ATTEMPTS) break;
      console.warn(
        `Envio de ${asset.name} falhou (tentativa ${attempt}); tentando de novo.`,
        error,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError ?? new Error(`Falha ao enviar ${asset.name}.`);
}

function cancelOnServer(id: string): void {
  // Melhor esforço: interrompe o FFmpeg e apaga os temporários no servidor.
  void fetch(`${API_BASE}/api/render/cancel?id=${encodeURIComponent(id)}`, {
    method: "POST",
    keepalive: true,
  }).catch(() => {});
}

export async function renderVideoOnServer(
  options: ServerRenderOptions,
): Promise<ServerRenderResult> {
  const id = generateId();
  const { onProgress, cancelRef } = options;
  const throwIfCancelled = () => {
    if (cancelRef?.cancelled) throw new Error("CANCELLED");
  };

  try {
    // 0. Falha rápido (antes de subir centenas de MB) se o servidor não tem FFmpeg.
    onProgress?.(0, "preparing", "Verificando o servidor de vídeo");
    try {
      const statusResponse = await fetch(`${API_BASE}/api/transcode/status`, {
        cache: "no-store",
      });
      if (statusResponse.ok) {
        const status = (await statusResponse.json()) as {
          available?: boolean;
          diagnostic?: string;
        };
        if (!status.available) {
          throw new Error(
            status.diagnostic ||
              "O servidor não tem FFmpeg instalado. Use o Dockerfile do projeto ou configure FFMPEG_PATH.",
          );
        }
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(
          "Não foi possível falar com o servidor de vídeo. Verifique se a aplicação está no ar.",
        );
      }
      throw error;
    }
    throwIfCancelled();

    // 1. Envio das mídias, uma por vez.
    const sources: SourceDescriptor[] = [
      ...options.images.map((image, index): SourceDescriptor => ({
        kind: "image",
        index,
        name: image.name,
        source: image.dataUrl || image.url,
        blob: image.blob,
      })),
      {
        kind: "narration",
        index: 0,
        name: options.narration.name,
        source: options.narration.dataUrl || options.narration.url,
        blob: options.narration.blob,
      },
    ];
    if (options.music) {
      sources.push({
        kind: "music",
        index: 0,
        name: options.music.name,
        source: options.music.dataUrl || options.music.url,
        blob: options.music.blob,
      });
    }

    const weights = sources.map((item) => estimateBytes(item.source));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let completedWeight = 0;
    const uploaded: { images: string[]; narration: string; music: string | null } = {
      images: [],
      narration: "",
      music: null,
    };
    for (let position = 0; position < sources.length; position += 1) {
      throwIfCancelled();
      const asset = sources[position]!;
      const weight = weights[position]!;
      const label = `${position + 1} de ${sources.length} — ${asset.name}`;
      onProgress?.((completedWeight / totalWeight) * UPLOAD_SHARE, "preparing", label);
      const blobSizeHint = weight;
      const fileName = await uploadAsset(
        id,
        asset,
        (loaded) => {
          const within = Math.min(1, loaded / blobSizeHint);
          onProgress?.(
            ((completedWeight + within * weight) / totalWeight) * UPLOAD_SHARE,
            "uploading",
            label,
          );
        },
        cancelRef,
      );
      completedWeight += weight;
      if (asset.kind === "image") uploaded.images.push(fileName);
      else if (asset.kind === "narration") uploaded.narration = fileName;
      else uploaded.music = fileName;
    }
    onProgress?.(UPLOAD_SHARE, "uploading", "Todos os arquivos enviados");
    throwIfCancelled();

    // 2. Inicia o job (responde na hora; o FFmpeg roda em segundo plano).
    const startResponse = await fetch(`${API_BASE}/api/render?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metadata: {
          width: options.width,
          height: options.height,
          fps: options.fps,
          duration: options.duration,
          musicVolume: options.musicVolume,
          narrationVolume: options.narrationVolume,
          kenBurns: options.kenBurns,
          motionEffect: options.motionEffect,
          fade: options.fade,
          format: options.format,
          captions: options.captions,
        },
        images: uploaded.images,
        narration: uploaded.narration,
        music: uploaded.music,
      }),
    });
    if (!startResponse.ok) throw new Error(await responseError(startResponse));

    // 3. Acompanha o progresso real do FFmpeg.
    onProgress?.(UPLOAD_SHARE, "encoding", "Iniciando montagem");
    let failures = 0;
    for (;;) {
      if (cancelRef?.cancelled) throw new Error("CANCELLED");
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
      if (cancelRef?.cancelled) throw new Error("CANCELLED");

      let progress: RenderProgress;
      try {
        const query = new URLSearchParams({ id, timestamp: String(Date.now()) });
        const response = await fetch(`${API_BASE}/api/render/progress?${query}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        progress = (await response.json()) as RenderProgress;
        failures = progress.status === "not_found" ? failures + 1 : 0;
      } catch (error) {
        failures += 1;
        console.warn("Falha temporária ao consultar o progresso da montagem.", error);
        if (failures >= POLL_MAX_FAILURES) {
          throw new Error("Perdi a conexão com o servidor durante a montagem. Tente novamente.");
        }
        continue;
      }

      if (progress.status === "error") {
        if (progress.error === "CANCELLED") throw new Error("CANCELLED");
        throw new Error(progress.error || "O servidor não conseguiu montar o vídeo.");
      }
      if (progress.status === "not_found") {
        if (failures >= 10) {
          throw new Error(
            "O servidor perdeu a montagem (provavelmente foi reiniciado). Tente novamente.",
          );
        }
        continue;
      }
      if (progress.status === "done") {
        onProgress?.(1, "encoding", "Vídeo pronto");
        return {
          id,
          url: `${API_BASE}/api/render/result?id=${encodeURIComponent(id)}`,
          size: progress.outputSize ?? 0,
        };
      }

      const fraction = Math.max(0, Math.min(1, progress.progress ?? 0));
      const elapsed = `${formatClock(progress.timeSec ?? 0)} / ${formatClock(options.duration)}`;
      onProgress?.(
        UPLOAD_SHARE + fraction * (1 - UPLOAD_SHARE),
        "encoding",
        progress.detail ? `${progress.detail} · ${elapsed}` : elapsed,
        progress.timeSec ?? 0,
      );
    }
  } catch (error) {
    if (cancelRef?.cancelled || (error instanceof Error && error.message === "CANCELLED")) {
      cancelOnServer(id);
      throw new Error("CANCELLED");
    }
    cancelOnServer(id);
    throw error;
  }
}

/** URL para baixar o arquivo com um nome amigável (o servidor envia Content-Disposition). */
export function buildDownloadUrl(resultUrl: string, filename: string): string {
  const separator = resultUrl.includes("?") ? "&" : "?";
  return `${resultUrl}${separator}download=1&filename=${encodeURIComponent(filename)}`;
}
