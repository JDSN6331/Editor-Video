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
  error?: string;
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

  try {
    options.onProgress?.(0.02);
    const startResponse = await fetch(`${API_BASE}/api/render/start?id=${encodeURIComponent(id)}`, {
      method: "POST",
      body: form,
    });
    if (!startResponse.ok) throw new Error(await responseError(startResponse));

    while (true) {
      if (options.cancelRef?.cancelled) {
        await fetch(`${API_BASE}/api/render/cancel/${encodeURIComponent(id)}`, {
          method: "POST",
          keepalive: true,
        }).catch(() => {});
        throw new Error("CANCELLED");
      }

      const statusResponse = await fetch(
        `${API_BASE}/api/render/progress/${encodeURIComponent(id)}?timestamp=${Date.now()}`,
        { cache: "no-store" },
      );
      if (!statusResponse.ok) throw new Error(await responseError(statusResponse));
      const progress = (await statusResponse.json()) as RenderProgress;
      if (progress.status === "error") throw new Error(progress.error || "Falha na montagem.");
      if (progress.status === "encoding" && options.duration > 0) {
        options.onProgress?.(
          Math.max(0.05, Math.min(0.99, (progress.timeSec || 0) / options.duration)),
        );
      }
      if (progress.status === "done") {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const resultResponse = await fetch(
            `${API_BASE}/api/render/result/${encodeURIComponent(id)}?timestamp=${Date.now()}`,
            { cache: "no-store" },
          );
          if (resultResponse.ok) {
            const blob = await resultResponse.blob();
            if (!blob.size) throw new Error("O servidor retornou um vídeo vazio.");
            options.onProgress?.(1);
            return blob;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
        throw new Error("O vídeo foi concluído, mas não ficou disponível para download.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (options.cancelRef?.cancelled || (error instanceof Error && error.message === "CANCELLED")) {
      throw new Error("CANCELLED");
    }
    throw error;
  }
}
