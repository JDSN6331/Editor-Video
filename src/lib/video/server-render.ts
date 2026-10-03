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
  onProgress?: (progress: number) => void;
  cancelRef?: { cancelled: boolean };
}

interface RenderProgress {
  status: "uploading" | "encoding" | "done" | "error" | "not_found";
  timeSec?: number;
}

const API_BASE = String(import.meta.env.VITE_TRANSCODE_API_URL || "").replace(/\/$/, "");

async function sourceToBlob(source: string): Promise<Blob> {
  const response = await fetch(source);
  if (!response.ok) throw new Error("Não foi possível preparar uma mídia para o servidor.");
  return response.blob();
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `O servidor respondeu com HTTP ${response.status}.`;
  } catch {
    return `O servidor respondeu com HTTP ${response.status}.`;
  }
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

  const imageBlobs = await Promise.all(
    options.images.map((image) => sourceToBlob(image.dataUrl || image.url)),
  );
  imageBlobs.forEach((blob, index) => {
    form.append("images", blob, options.images[index]?.name || `image-${index + 1}`);
  });
  form.append(
    "narration",
    await sourceToBlob(options.narration.dataUrl || options.narration.url),
    options.narration.name,
  );
  if (options.music) {
    form.append(
      "music",
      await sourceToBlob(options.music.dataUrl || options.music.url),
      options.music.name,
    );
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
          Math.max(0.05, Math.min(0.99, (progress.timeSec || 0) / options.duration)),
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
    options.onProgress?.(0.02);
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
    options.onProgress?.(1);
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
