import { drawFrame } from "./draw";
import type { Caption } from "./types";
import { transcodeWebMToMp4 } from "./transcode";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export interface RenderOptions {
  images: HTMLImageElement[];
  narrationBuffer: AudioBuffer;
  musicBuffer?: AudioBuffer | null;
  musicVolume: number; // 0..1
  narrationVolume: number; // 0..1
  captions: Caption[] | null;
  width: number;
  height: number;
  fps: number;
  kenBurns: boolean;
  fade: number;
  format?: "mp4" | "webm";
  previewCanvas?: HTMLCanvasElement | null;
  onProgress?: (progress: number, stage: "rendering" | "encoding") => void;
  cancelRef?: { cancelled: boolean };
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  duration: number;
}

export function pickMimeType(): {
  mimeType: string;
  extension: string;
} {
  const webmCandidates = [
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
  ];

  for (const c of webmCandidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType)) {
      return c;
    }
  }
  return { mimeType: "", extension: "webm" };
}

function createFrameClock(fps: number, onTick: () => void): () => void {
  // Blob Workers can be silently blocked by browser/content-security policies.
  // A page timer is less exotic and, combined with requestFrame(), produces a
  // frame for every tick without depending on requestAnimationFrame visibility.
  const timer = window.setInterval(onTick, Math.max(16, Math.round(1000 / fps)));
  return () => window.clearInterval(timer);
}

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext não suportado");
  const ctx = new Ctx();
  try {
    const data = await file.arrayBuffer();
    return await ctx.decodeAudioData(data.slice(0));
  } catch {
    throw new Error(`Não foi possível decodificar ${file.name}. Tente MP3, WAV, M4A/AAC ou OGG.`);
  } finally {
    void ctx.close();
  }
}

async function ensureImagesReady(images: HTMLImageElement[]) {
  await Promise.all(
    images.map(async (image, index) => {
      if (!image.complete || image.naturalWidth === 0) {
        try {
          await image.decode();
        } catch {
          throw new Error(`A imagem ${index + 1} não pôde ser preparada para o vídeo.`);
        }
      }
      if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        throw new Error(`A imagem ${index + 1} está vazia ou corrompida.`);
      }
    }),
  );
}

/**
 * Renderiza o vídeo em tempo real: canvas (vídeo) + WebAudio (narração + trilha)
 * capturados por MediaRecorder. A duração do vídeo = duração da narração.
 */
export async function renderVideo(options: RenderOptions): Promise<RenderResult> {
  const {
    images,
    narrationBuffer,
    musicBuffer,
    musicVolume,
    narrationVolume,
    captions,
    width,
    height,
    fps,
    kenBurns,
    fade,
    previewCanvas,
    onProgress,
    cancelRef,
  } = options;

  if (!images.length) throw new Error("Adicione ao menos uma imagem.");
  await ensureImagesReady(images);
  const duration = narrationBuffer.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("A narração não possui uma duração válida.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponível neste navegador.");

  const previewCtx = previewCanvas?.getContext("2d") ?? null;
  if (previewCanvas) {
    previewCanvas.width = Math.round(width / 2);
    previewCanvas.height = Math.round(height / 2);
  }

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext indisponível.");
  const audioCtx: AudioContext = new Ctx();
  const destination = audioCtx.createMediaStreamDestination();

  const narrationSource = audioCtx.createBufferSource();
  narrationSource.buffer = narrationBuffer;
  const narrationGain = audioCtx.createGain();
  narrationGain.gain.value = narrationVolume;
  narrationSource.connect(narrationGain).connect(destination);

  let musicSource: AudioBufferSourceNode | null = null;
  if (musicBuffer) {
    musicSource = audioCtx.createBufferSource();
    musicSource.buffer = musicBuffer;
    musicSource.loop = true;
    const musicGain = audioCtx.createGain();
    musicGain.gain.value = musicVolume;
    // fade out da trilha nos últimos 2s
    const start = audioCtx.currentTime;
    musicGain.gain.setValueAtTime(musicVolume, start);
    musicGain.gain.setValueAtTime(musicVolume, start + Math.max(0, duration - 2));
    musicGain.gain.linearRampToValueAtTime(0.0001, start + duration);
    musicSource.connect(musicGain).connect(destination);
  }

  // O primeiro quadro deve existir antes da captura; isso evita gravações congeladas
  // no quadro inicial em implementações mais estritas de captureStream.
  drawFrame(ctx, images, 0, duration, width, height, captions, { kenBurns, fade });
  const stream = canvas.captureStream(0);
  const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!videoTrack) {
    throw new Error("O navegador não criou a faixa de vídeo do canvas.");
  }
  videoTrack.requestFrame();
  const audioTrack = destination.stream.getAudioTracks()[0];
  if (!audioTrack) {
    throw new Error("O navegador não criou a faixa de áudio da narração.");
  }
  audioTrack.enabled = true;
  stream.addTrack(audioTrack);

  // Mantém o grafo WebAudio ativo sem reproduzir o áudio nos alto-falantes.
  const silentOutput = audioCtx.createGain();
  silentOutput.gain.value = 0;
  narrationGain.connect(silentOutput);
  silentOutput.connect(audioCtx.destination);

  const { mimeType } = pickMimeType();
  const recorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType, videoBitsPerSecond: width >= 1920 ? 10_000_000 : 6_000_000 } : undefined,
  );
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    recorder.addEventListener("error", () =>
      reject(new Error("O navegador interrompeu a gravação do vídeo.")),
    );
  });

  await Promise.race([
    audioCtx.resume(),
    new Promise<never>((_, reject) =>
      window.setTimeout(
        () =>
          reject(new Error("O navegador não liberou o áudio. Clique novamente em montar o vídeo.")),
        3000,
      ),
    ),
  ]);
  if (audioCtx.state !== "running") {
    throw new Error("O navegador manteve o áudio suspenso. Clique novamente em montar o vídeo.");
  }
  recorder.start(1000);
  if (recorder.state !== "recording") {
    throw new Error("Não foi possível iniciar o gravador de vídeo.");
  }

  const audioStartTime = audioCtx.currentTime + 0.15;
  const wallStartTime = performance.now() + 150;
  narrationSource.start(audioStartTime);
  musicSource?.start(audioStartTime);

  await new Promise<void>((resolve) => {
    let stopClock = () => {};
    let lastPreviewAt = 0;
    let lastProgressAt = 0;
    const tick = () => {
      // performance.now() is monotonic and keeps video progress independent of
      // AudioContext clock quirks seen in some Chromium/Windows configurations.
      const t = (performance.now() - wallStartTime) / 1000;
      if (cancelRef?.cancelled || t >= duration) {
        stopClock();
        drawFrame(ctx, images, Math.max(0, duration - 0.01), duration, width, height, captions, {
          kenBurns,
          fade,
        });
        videoTrack.requestFrame();
        resolve();
        return;
      }
      const clamped = Math.max(0, t);
      drawFrame(ctx, images, clamped, duration, width, height, captions, { kenBurns, fade });
      videoTrack.requestFrame();
      if (previewCtx && previewCanvas && clamped - lastPreviewAt >= 0.1) {
        previewCtx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
        lastPreviewAt = clamped;
      }
      if (clamped - lastProgressAt >= 0.25) {
        onProgress?.((clamped / duration) * 85, "rendering");
        lastProgressAt = clamped;
      }
    };
    // Capturing 60 full-HD canvas frames per second can starve MediaRecorder.
    // The final encoder still emits the selected FPS with stable timestamps.
    stopClock = createFrameClock(Math.min(fps, 30), tick);
    tick();
  });

  // pequeno respiro para o último chunk
  await new Promise((r) => setTimeout(r, 250));
  if (recorder.state !== "inactive") recorder.stop();
  try {
    narrationSource.stop();
    musicSource?.stop();
  } catch {
    /* já parou */
  }
  const recordedBlob = await finished;
  void audioCtx.close();

  if ((options.format || "mp4") === "mp4") {
    onProgress?.(85, "encoding");
    const mp4 = await transcodeWebMToMp4(recordedBlob, fps, (value) =>
      onProgress?.(85 + value * 15, "encoding"),
    );
    onProgress?.(100, "encoding");
    return { blob: mp4, mimeType: "video/mp4", extension: "mp4", duration };
  }

  onProgress?.(100, "encoding");
  return { blob: recordedBlob, mimeType: mimeType || "video/webm", extension: "webm", duration };
}
