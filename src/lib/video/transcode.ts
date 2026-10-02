interface ServerProgress {
  status: "uploading" | "encoding" | "done" | "error" | "not_found";
  timeSec?: number;
  error?: string;
}

interface ServerStatus {
  available: boolean;
  diagnostic?: string;
}

const TRANSCODE_API_BASE = String(import.meta.env.VITE_TRANSCODE_API_URL || "").replace(/\/$/, "");

function apiUrl(path: string): string {
  return `${TRANSCODE_API_BASE}${path}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `O servidor respondeu com HTTP ${response.status}.`;
  } catch {
    return `O servidor respondeu com HTTP ${response.status}.`;
  }
}

/** Envia o WebM ao FFmpeg nativo do servidor; nenhum FFmpeg/WASM roda no cliente. */
export async function transcodeWebMToMp4(
  input: Blob,
  fps: number,
  duration?: number,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const statusResponse = await fetch(apiUrl("/api/transcode/status"), { cache: "no-store" });
  if (!statusResponse.ok) throw new Error(await readError(statusResponse));

  const serverStatus = (await statusResponse.json()) as ServerStatus;
  if (!serverStatus.available) {
    throw new Error(
      serverStatus.diagnostic ||
        "FFmpeg nativo nao esta disponivel no servidor. Publique usando o Dockerfile do projeto.",
    );
  }

  const id = crypto.randomUUID();
  let finished = false;
  const poll = window.setInterval(async () => {
    if (finished) return;
    try {
      const response = await fetch(apiUrl(`/api/transcode/progress?id=${encodeURIComponent(id)}`), {
        cache: "no-store",
      });
      if (!response.ok) return;
      const progress = (await response.json()) as ServerProgress;
      if (progress.status === "encoding" && duration && duration > 0) {
        onProgress?.(Math.max(0, Math.min(0.99, (progress.timeSec || 0) / duration)));
      }
    } catch {
      // A requisicao principal fornece o erro definitivo.
    }
  }, 750);

  try {
    onProgress?.(0);
    const response = await fetch(
      apiUrl(`/api/transcode?id=${encodeURIComponent(id)}&fps=${encodeURIComponent(fps)}`),
      {
        method: "POST",
        headers: { "Content-Type": input.type || "video/webm" },
        body: input,
      },
    );
    if (!response.ok) throw new Error(await readError(response));
    const output = await response.blob();
    if (!output.size || !output.type.includes("video/mp4")) {
      throw new Error("O servidor retornou um MP4 vazio ou invalido.");
    }
    onProgress?.(1);
    return output;
  } finally {
    finished = true;
    window.clearInterval(poll);
  }
}
