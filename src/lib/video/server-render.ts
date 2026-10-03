import type { Caption } from "./types";

interface ServerRenderOptions {
  images: Array<{ name: string; dataUrl?: string; url: string }>;
  narration: { name: string; dataUrl?: string; url: string };
  music?: { name: string; dataUrl?: string; url: string } | null;
  captions: Caption[] | null;
  width: number;
  height: number;
  fps: number;
  duration: number;
  musicVolume: number;
  narrationVolume: number;
  kenBurns: boolean;
  fade: number;
  format: "mp4" | "webm";
  onProgress?: (
    progress: number,
    stage: "preparing" | "uploading" | "encoding",
    detail?: string,
  ) => void;
  cancelRef?: { cancelled: boolean };
}

interface RenderProgress {
  status: "uploading" | "encoding" | "done" | "error" | "not_found";
  timeSec?: number;
}

type PreparedAsset = {
  kind: "image" | "narration" | "music";
  index: number;
  name: string;
  blob: Blob;
};

const API_BASE = String(import.meta.env.VITE_TRANSCODE_API_URL || "").replace(/\/$/, "");

function dataUrlToBlob(source: string): Blob {
  const separator = source.indexOf(",");
  if (separator < 0) throw new Error("Data URL inválida.");
  const header = source.slice(0, separator);
  const content = source.slice(separator + 1);
  const mimeType = header.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  if (!header.includes(";base64")) {
    return new Blob([decodeURIComponent(content)], { type: mimeType });
  }

  const parts: Uint8Array[] = [];
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    const decoded = atob(content.slice(offset, offset + chunkSize));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1)
      bytes[index] = decoded.charCodeAt(index);
    parts.push(bytes);
  }
  return new Blob(parts, { type: mimeType });
}

async function sourceToBlob(source: string, name: string): Promise<Blob> {
  if (source.startsWith("data:")) return dataUrlToBlob(source);
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

async function responseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `O servidor respondeu com HTTP ${response.status}.`;
  } catch {
    return `O servidor respondeu com HTTP ${response.status}.`;
  }
}

function uploadAsset(
  id: string,
  asset: PreparedAsset,
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
    request.timeout = 2 * 60 * 1000;
    request.upload.onprogress = (event) => onLoaded(event.loaded);
    const cancelTimer = window.setInterval(() => {
      if (cancelRef?.cancelled) request.abort();
    }, 200);
    const finish = () => window.clearInterval(cancelTimer);
    request.onload = () => {
      finish();
      const payload = (request.response || {}) as { fileName?: string; error?: string };
      if (request.status >= 200 && request.status < 300 && payload.fileName) {
        onLoaded(asset.blob.size);
        resolve(payload.fileName);
      } else {
        reject(new Error(payload.error || `Falha ao enviar ${asset.name}.`));
      }
    };
    request.onerror = () => {
      finish();
      reject(new Error(`Falha de conexão ao enviar ${asset.name}.`));
    };
    request.ontimeout = () => {
      finish();
      reject(new Error(`O envio de ${asset.name} excedeu 2 minutos.`));
    };
    request.onabort = () => {
      finish();
      reject(new Error("CANCELLED"));
    };
    request.send(asset.blob);
  });
}

export async function renderVideoOnServer(options: ServerRenderOptions): Promise<Blob> {
  const id = crypto.randomUUID();
  const form = new FormData();
  const metadata = {
    width: options.width,
    height: options.height,
    fps: options.fps,
    duration: options.duration,
    musicVolume: options.musicVolume,
    narrationVolume: options.narrationVolume,
    kenBurns: options.kenBurns,
    fade: options.fade,
    format: options.format,
    captions: options.captions,
  };
  form.append("metadata", JSON.stringify(metadata));
  // Campo redundante para parsers multipart/proxies que possam alterar o JSON.
  form.append("duration", String(options.duration));

  const assets: PreparedAsset[] = [];
  const mediaCount = options.images.length + 1 + (options.music ? 1 : 0);
  let prepared = 0;
  const reportPrepared = (name: string) => {
    prepared += 1;
    options.onProgress?.((prepared / mediaCount) * 0.02, "preparing", name);
  };
  for (let index = 0; index < options.images.length; index += 1) {
    if (options.cancelRef?.cancelled) throw new Error("CANCELLED");
    const image = options.images[index]!;
    const blob = await sourceToBlob(image.dataUrl || image.url, image.name);
    assets.push({ kind: "image", index, name: image.name, blob });
    reportPrepared(image.name);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  const narrationBlob = await sourceToBlob(
    options.narration.dataUrl || options.narration.url,
    options.narration.name,
  );
  assets.push({ kind: "narration", index: 0, name: options.narration.name, blob: narrationBlob });
  reportPrepared(options.narration.name);
  if (options.music) {
    const musicBlob = await sourceToBlob(
      options.music.dataUrl || options.music.url,
      options.music.name,
    );
    assets.push({ kind: "music", index: 0, name: options.music.name, blob: musicBlob });
    reportPrepared(options.music.name);
  }

  const totalBytes = Math.max(
    1,
    assets.reduce((sum, asset) => sum + asset.blob.size, 0),
  );
  let completedBytes = 0;
  for (const asset of assets) {
    if (options.cancelRef?.cancelled) throw new Error("CANCELLED");
    const fileName = await uploadAsset(
      id,
      asset,
      (loaded) => {
        const uploadFraction = (completedBytes + loaded) / totalBytes;
        options.onProgress?.(0.02 + uploadFraction * 0.08, "uploading", asset.name);
      },
      options.cancelRef,
    );
    completedBytes += asset.blob.size;
    if (asset.kind === "image") form.append("images", fileName);
    else form.append(asset.kind, fileName);
  }

  const controller = new AbortController();
  let finished = false;
  let pollTimer = 0;
  const poll = async () => {
    if (finished) return;
    if (options.cancelRef?.cancelled) {
      controller.abort();
      return;
    }
    try {
      const query = new URLSearchParams({ id, timestamp: String(Date.now()) });
      const response = await fetch(`${API_BASE}/api/render/progress?${query}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const progress = (await response.json()) as RenderProgress;
      if (progress.status === "encoding" && options.duration > 0) {
        options.onProgress?.(
          0.1 + Math.min(0.89, ((progress.timeSec || 0) / options.duration) * 0.89),
          "encoding",
        );
      }
    } catch (error) {
      console.warn("Falha temporária ao atualizar o progresso da montagem.", error);
      // A requisição principal fornece o erro definitivo.
    } finally {
      if (!finished) pollTimer = window.setTimeout(() => void poll(), 1000);
    }
  };

  try {
    const renderRequest = fetch(`${API_BASE}/api/render?id=${encodeURIComponent(id)}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    void poll();
    const response = await renderRequest;
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    if (!blob.size) throw new Error("O servidor retornou um vídeo vazio.");
    options.onProgress?.(1, "encoding");
    return blob;
  } catch (error) {
    if (
      options.cancelRef?.cancelled ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw new Error("CANCELLED");
    }
    throw error;
  } finally {
    finished = true;
    if (pollTimer) window.clearTimeout(pollTimer);
  }
}
