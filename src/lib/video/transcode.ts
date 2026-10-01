interface FFmpegProgressEvent {
  progress: number;
  time: number;
}

interface FFmpegInstance {
  loaded: boolean;
  load: (config: { coreURL: string; wasmURL: string; classWorkerURL?: string }) => Promise<boolean>;
  on: (
    event: "progress" | "log",
    callback: ((event: FFmpegProgressEvent) => void) | ((event: { message: string }) => void),
  ) => void;
  off: (
    event: "progress" | "log",
    callback: ((event: FFmpegProgressEvent) => void) | ((event: { message: string }) => void),
  ) => void;
  writeFile: (path: string, data: Uint8Array) => Promise<boolean>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<boolean>;
  exec: (args: string[]) => Promise<number>;
}

type FFmpegConstructor = new () => FFmpegInstance;

const FFMPEG_MODULE_URL = "/vendor/ffmpeg/index.js";
const FFMPEG_CORE_URL = "/vendor/ffmpeg/ffmpeg-core.js";
const FFMPEG_WASM_URL = "/vendor/ffmpeg/ffmpeg-core.wasm";

let ffmpegPromise: Promise<FFmpegInstance> | null = null;

async function getFFmpeg(): Promise<FFmpegInstance> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      // An absolute runtime URL keeps Vite from treating a public asset as a
      // source module (which otherwise adds `?import` and returns HTTP 500).
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

function parseFFmpegTime(message: string): number | null {
  // Matches time=00:00:04.12 or time= 01:23:45.67
  const hms = message.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (hms && hms[1] && hms[2] && hms[3]) {
    return parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60 + parseFloat(hms[3]);
  }
  // Matches time=00:04.12
  const ms = message.match(/time=\s*(\d+):(\d+(?:\.\d+)?)/);
  if (ms && ms[1] && ms[2]) {
    return parseInt(ms[1], 10) * 60 + parseFloat(ms[2]);
  }
  // Matches time=4.12
  const sec = message.match(/time=\s*(\d+(?:\.\d+)?)/);
  if (sec && sec[1]) {
    return parseFloat(sec[1]);
  }
  return null;
}

export async function transcodeWebMToMp4(
  input: Blob,
  fps: number,
  duration?: number,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const suffix = crypto.randomUUID();
  const inputName = `input-${suffix}.webm`;
  const outputName = `output-${suffix}.mp4`;

  let lastReported = 0;
  let lastReportAt = 0;

  const report = (p: number) => {
    const clamped = Math.max(0, Math.min(1, p));
    const now = performance.now();
    if (clamped > lastReported && (clamped >= 1 || clamped - lastReported >= 0.005 || now - lastReportAt >= 100)) {
      lastReported = clamped;
      lastReportAt = now;
      onProgress?.(clamped);
    }
  };

  const handleProgress = (event: FFmpegProgressEvent) => {
    if (Number.isFinite(event.progress) && event.progress > 0 && event.progress <= 1) {
      report(event.progress);
      return;
    }
    if (Number.isFinite(event.time) && event.time > 0 && duration && duration > 0) {
      // In @ffmpeg/ffmpeg 0.12, time is in microseconds (1s = 1,000,000us)
      const secs = event.time > 100_000 ? event.time / 1_000_000 : event.time > 1_000 ? event.time / 1_000 : event.time;
      report(secs / duration);
    }
  };

  const handleLog = ({ message }: { message: string }) => {
    if (duration && duration > 0 && message.includes("time=")) {
      const secs = parseFFmpegTime(message);
      if (secs !== null && secs >= 0) {
        report(secs / duration);
      }
    }
  };

  ffmpeg.on("progress", handleProgress as (event: FFmpegProgressEvent) => void);
  ffmpeg.on("log", handleLog as (event: { message: string }) => void);

  const startTime = performance.now();
  const estimatedTranscodeMs = Math.max(6000, (duration ?? 10) * 350);
  const heartbeat = setInterval(() => {
    if (lastReported < 0.95) {
      const elapsed = performance.now() - startTime;
      const estimatedP = Math.min(0.95, elapsed / estimatedTranscodeMs);
      if (estimatedP > lastReported) {
        report(estimatedP);
      }
    }
  }, 400);

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await input.arrayBuffer()));
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
    if (exitCode !== 0) {
      throw new Error(`O FFmpeg não conseguiu finalizar o MP4 (código ${exitCode}).`);
    }
    const data = await ffmpeg.readFile(outputName);
    if (!(data instanceof Uint8Array)) {
      throw new Error("O FFmpeg retornou uma saída inválida.");
    }
    report(1);
    return new Blob([data.buffer as ArrayBuffer], { type: "video/mp4" });
  } finally {
    clearInterval(heartbeat);
    ffmpeg.off("progress", handleProgress as (event: FFmpegProgressEvent) => void);
    ffmpeg.off("log", handleLog as (event: { message: string }) => void);
    await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(outputName)]);
  }
}
