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

export async function transcodeWebMToMp4(
  input: Blob,
  fps: number,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const suffix = crypto.randomUUID();
  const inputName = `input-${suffix}.webm`;
  const outputName = `output-${suffix}.mp4`;
  const handleProgress = ({ progress }: FFmpegProgressEvent) => {
    if (Number.isFinite(progress)) onProgress?.(Math.max(0, Math.min(1, progress)));
  };

  ffmpeg.on("progress", handleProgress);
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
    return new Blob([data], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", handleProgress);
    await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(outputName)]);
  }
}
