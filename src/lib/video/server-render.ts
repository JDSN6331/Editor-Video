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
  onProgress?: (progress: number, stage: "preparing" | "uploading" | "encoding") => void;
  cancelRef?: { cancelled: boolean };
}

interface RenderProgress {
  status: "uploading" | "encoding" | "done" | "error" | "not_found";
  timeSec?: number;
  error?: string;
}

const API_BASE = String(import.meta.env.VITE_TRANSCODE_API_URL || "").replace(/\/$/, "");
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

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

function uploadRenderForm(
  url: string,
  form: FormData,
  onProgress?: (progress: number, stage: "preparing" | "uploading" | "encoding") => void,
  cancelRef?: { cancelled: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(0.05 + Math.min(0.1, (event.loaded / event.total) * 0.1), "uploading");
      }
    };

    const cancelTimer = window.setInterval(() => {
      if (cancelRef?.cancelled) xhr.abort();
    }, 200);
    const finish = () => window.clearInterval(cancelTimer);
    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(0.15, "uploading");
        resolve();
        return;
      }
      const payload = (xhr.response || {}) as { error?: string };
      reject(new Error(payload.error || `O servidor respondeu com HTTP ${xhr.status}.`));
    };
    xhr.onerror = () => {
      finish();
      reject(new Error("Falha de conexão durante o envio das mídias."));
    };
    xhr.ontimeout = () => {
      finish();
      reject(new Error("O envio excedeu 2 minutos. Verifique o proxy do Easypanel."));
    };
    xhr.onabort = () => {
      finish();
      reject(new Error("CANCELLED"));
    };
    xhr.send(form);
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

  const mediaCount = options.images.length + 1 + (options.music ? 1 : 0);
  let preparedCount = 0;
  const appendPrepared = () => {
    preparedCount += 1;
    options.onProgress?.((preparedCount / mediaCount) * 0.05, "preparing");
  };
  for (let index = 0; index < options.images.length; index += 1) {
    if (options.cancelRef?.cancelled) throw new Error("CANCELLED");
    const image = options.images[index]!;
    const blob = await sourceToBlob(image.dataUrl || image.url);
    form.append("images", blob, image.name || `image-${index + 1}`);
    appendPrepared();
  }
  const narrationBlob = await sourceToBlob(options.narration.dataUrl || options.narration.url);
  form.append("narration", narrationBlob, options.narration.name);
  appendPrepared();
  if (options.music) {
    const musicBlob = await sourceToBlob(options.music.dataUrl || options.music.url);
    form.append("music", musicBlob, options.music.name);
    appendPrepared();
  }

  try {
    await uploadRenderForm(
      `${API_BASE}/api/render/start?id=${encodeURIComponent(id)}`,
      form,
      options.onProgress,
      options.cancelRef,
    );

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
          0.15 + Math.min(0.84, ((progress.timeSec || 0) / options.duration) * 0.84),
          "encoding",
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
            options.onProgress?.(1, "encoding");
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
