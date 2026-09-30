import { drawFrame } from "./draw";
import type { Caption } from "./types";

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
  previewCanvas?: HTMLCanvasElement | null;
  onProgress?: (elapsed: number, total: number) => void;
  cancelRef?: { cancelled: boolean };
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  duration: number;
}

function pickMimeType(): { mimeType: string; extension: string } {
  const candidates = [
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
    { mimeType: "video/mp4", extension: "mp4" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: "", extension: "webm" };
}

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  const data = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(data);
  void ctx.close();
  return buffer;
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
  const duration = narrationBuffer.duration;

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

  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
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

  const stream = canvas.captureStream(fps);
  const audioTrack = destination.stream.getAudioTracks()[0];
  if (audioTrack) stream.addTrack(audioTrack);

  const { mimeType, extension } = pickMimeType();
  const recorder = new MediaRecorder(
    stream,
    mimeType
      ? { mimeType, videoBitsPerSecond: width >= 1920 ? 10_000_000 : 6_000_000 }
      : undefined,
  );
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
  });

  await audioCtx.resume();
  const startTime = audioCtx.currentTime + 0.1;
  narrationSource.start(startTime);
  musicSource?.start(startTime);
  recorder.start(1000);

  await new Promise<void>((resolve) => {
    let raf = 0;
    const tick = () => {
      const t = audioCtx.currentTime - startTime;
      if (cancelRef?.cancelled || t >= duration) {
        cancelAnimationFrame(raf);
        drawFrame(ctx, images, Math.max(0, duration - 0.01), duration, width, height, captions, {
          kenBurns,
          fade,
        });
        resolve();
        return;
      }
      const clamped = Math.max(0, t);
      drawFrame(ctx, images, clamped, duration, width, height, captions, { kenBurns, fade });
      if (previewCtx && previewCanvas) {
        previewCtx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
      }
      onProgress?.(clamped, duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });

  // pequeno respiro para o último chunk
  await new Promise((r) => setTimeout(r, 250));
  recorder.stop();
  try {
    narrationSource.stop();
    musicSource?.stop();
  } catch {
    /* já parou */
  }
  const blob = await finished;
  void audioCtx.close();

  return { blob, mimeType: mimeType || "video/webm", extension, duration };
}
