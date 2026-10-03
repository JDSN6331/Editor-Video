import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { activeJobs, getFfmpegPath } from "./transcode-service";

interface CaptionInput {
  start: number;
  end: number;
  text: string;
}

interface RenderMetadata {
  width: number;
  height: number;
  fps: number;
  duration: number;
  musicVolume: number;
  narrationVolume: number;
  kenBurns: boolean;
  fade: number;
  format: "mp4" | "webm";
  captions: CaptionInput[] | null;
}

function safeJobId(value: string | null): string {
  return value && /^[a-zA-Z0-9-]{1,64}$/.test(value) ? value : randomUUID();
}

function uploadDirectory(id: string): string {
  return path.join(os.tmpdir(), `studio-render-upload-${id}`);
}

function safeStoredName(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9._-]+$/.test(value) ? value : null;
}

export async function handleFetchRenderUpload(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = safeJobId(url.searchParams.get("id"));
  const kind = url.searchParams.get("kind");
  const index = Number.parseInt(url.searchParams.get("index") || "0", 10);
  const originalName = url.searchParams.get("name") || "asset.bin";
  if (!request.body || !["image", "narration", "music"].includes(kind || "")) {
    return Response.json({ error: "Upload inválido." }, { status: 400 });
  }

  const extension = path.extname(originalName).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,6}$/.test(extension) ? extension : ".bin";
  const fileName = kind === "image" ? `image-${index}${safeExtension}` : `${kind}${safeExtension}`;
  const directory = uploadDirectory(id);
  const target = path.join(directory, fileName);
  try {
    await fs.mkdir(directory, { recursive: true });
    await pipeline(Readable.fromWeb(request.body as never), createWriteStream(target));
    return Response.json({ fileName }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await fs.unlink(target).catch(() => {});
    const message = error instanceof Error ? error.message : "Falha ao receber arquivo.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function validateMetadata(raw: unknown, durationField?: FormDataEntryValue | null): RenderMetadata {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const width = numberInRange(input.width, 1920, 320, 1920);
  const height = numberInRange(input.height, 1080, 180, 1080);
  const fps = [24, 30, 60].includes(Number(input.fps)) ? Number(input.fps) : 30;
  const rawCaptions = Array.isArray(input.captions) ? input.captions : [];
  const captionDuration = rawCaptions.reduce((largest, item) => {
    const end = Number((item as Record<string, unknown>)?.end);
    return Number.isFinite(end) ? Math.max(largest, end) : largest;
  }, 0);
  const separateDuration = Number(durationField);
  const fallbackDuration =
    Number.isFinite(separateDuration) && separateDuration > 0 ? separateDuration : captionDuration;
  const duration = numberInRange(input.duration, fallbackDuration, 0.1, 3600);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Duração inválida para a montagem. Recarregue a narração e tente novamente.");
  }
  const captions = rawCaptions
    .slice(0, 5000)
    .map((item) => {
      const caption = item as Record<string, unknown>;
      return {
        start: numberInRange(caption.start, 0, 0, duration),
        end: numberInRange(caption.end, 0, 0, duration),
        text: String(caption.text || "").slice(0, 1000),
      };
    })
    .filter((caption) => caption.text && caption.end > caption.start);
  return {
    width: Math.round(width / 2) * 2,
    height: Math.round(height / 2) * 2,
    fps,
    duration,
    musicVolume: numberInRange(input.musicVolume, 0.15, 0, 1),
    narrationVolume: numberInRange(input.narrationVolume, 1, 0, 1),
    kenBurns: input.kenBurns !== false,
    fade: numberInRange(input.fade, 0.6, 0, 1.5),
    format: input.format === "webm" ? "webm" : "mp4",
    captions,
  };
}

function extensionFor(file: File, fallback: string): string {
  const extension = path.extname(file.name).toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(extension) ? extension : fallback;
}

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const whole = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function assText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function buildAss(captions: CaptionInput[], width: number, height: number): string {
  const fontSize = Math.round(height * 0.055);
  const marginV = Math.round(height * 0.075);
  const events = captions.map((caption) => {
    const words = caption.text.trim().split(/\s+/).filter(Boolean);
    const totalCs = Math.max(1, Math.round((caption.end - caption.start) * 100));
    const totalChars = Math.max(
      1,
      words.reduce((sum, word) => sum + word.length, 0),
    );
    let used = 0;
    const karaoke = words
      .map((word, index) => {
        const remaining = totalCs - used;
        const duration =
          index === words.length - 1
            ? Math.max(1, remaining)
            : Math.max(1, Math.round((totalCs * word.length) / totalChars));
        used += duration;
        // Palavra por palavra acompanha melhor o ritmo do que a varredura
        // contínua do karaoke \kf.
        return `{\\k${duration}}${assText(word)}`;
      })
      .join(" ");
    return `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,${karaoke}`;
  });
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,${fontSize},&H003FD2FF,&H00F2F2F2,&H00101010,&H705C5C5C,-1,0,0,0,100,100,0,0,3,5,0,2,80,80,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

function parseTime(value: string): number {
  const parts = value.split(":").map(Number);
  return parts.length === 3 ? (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0) : 0;
}

async function runFfmpeg(
  args: string[],
  jobId: string,
  onTime?: (seconds: number) => void,
): Promise<void> {
  const binary = getFfmpegPath();
  if (!binary) throw new Error("FFmpeg nativo não está disponível no servidor.");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-16000);
      const matches = [...text.matchAll(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
      const latestTime = matches.at(-1)?.[1];
      if (latestTime) {
        const seconds = parseTime(latestTime);
        const job = activeJobs.get(jobId);
        if (onTime) onTime(seconds);
        else if (job) job.timeSec = Math.max(job.timeSec, seconds);
      }
    });
    proc.on("error", (error) => reject(new Error(`Falha ao iniciar FFmpeg: ${error.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`FFmpeg falhou (${code}): ${stderr.split("\n").slice(-10).join("\n")}`));
    });
  });
}

export async function handleFetchRender(request: Request): Promise<Response> {
  const binary = getFfmpegPath();
  if (!binary) return Response.json({ error: "FFmpeg não disponível." }, { status: 503 });
  const id = safeJobId(new URL(request.url).searchParams.get("id"));
  const preparedDirectory = uploadDirectory(id);
  const workDir = (await fs.stat(preparedDirectory).catch(() => null))?.isDirectory()
    ? preparedDirectory
    : await fs.mkdtemp(path.join(os.tmpdir(), `studio-render-${id}-`));
  activeJobs.set(id, { status: "uploading", timeSec: 0, fps: 0, speed: "0x" });
  try {
    const form = await request.formData();
    const metadata = validateMetadata(
      JSON.parse(String(form.get("metadata") || "{}")),
      form.get("duration"),
    );
    const imageEntries = form.getAll("images");
    const narration = form.get("narration");
    const music = form.get("music");
    if (!imageEntries.length || (!safeStoredName(narration) && !(narration instanceof File))) {
      throw new Error("Imagens ou narração não foram recebidas pelo servidor.");
    }
    if (imageEntries.length > 200) throw new Error("O limite é de 200 imagens por vídeo.");

    const imagePaths: string[] = [];
    for (let index = 0; index < imageEntries.length; index += 1) {
      const entry = imageEntries[index]!;
      const storedName = safeStoredName(entry);
      const filePath = storedName
        ? path.join(workDir, storedName)
        : path.join(
            workDir,
            `image-${String(index).padStart(3, "0")}${extensionFor(entry as File, ".img")}`,
          );
      if (entry instanceof File)
        await fs.writeFile(filePath, Buffer.from(await entry.arrayBuffer()));
      else await fs.access(filePath);
      imagePaths.push(filePath);
    }
    const storedNarration = safeStoredName(narration);
    const narrationPath = storedNarration
      ? path.join(workDir, storedNarration)
      : path.join(workDir, `narration${extensionFor(narration as File, ".audio")}`);
    if (narration instanceof File)
      await fs.writeFile(narrationPath, Buffer.from(await narration.arrayBuffer()));
    else await fs.access(narrationPath);
    let musicPath: string | null = null;
    const storedMusic = safeStoredName(music);
    if (storedMusic) {
      musicPath = path.join(workDir, storedMusic);
      await fs.access(musicPath);
    } else if (music instanceof File && music.size > 0) {
      musicPath = path.join(workDir, `music${extensionFor(music, ".audio")}`);
      await fs.writeFile(musicPath, Buffer.from(await music.arrayBuffer()));
    }
    const assPath = path.join(workDir, "captions.ass");
    if (metadata.captions?.length) {
      await fs.writeFile(
        assPath,
        buildAss(metadata.captions, metadata.width, metadata.height),
        "utf8",
      );
    }
    const outputPath = path.join(
      workDir,
      metadata.format === "webm" ? "output.webm" : "output.mp4",
    );
    const perImage = metadata.duration / imagePaths.length;
    // A superfície 2x reduz o arredondamento do zoompan que fazia o centro
    // oscilar entre pixels e dava a impressão de imagem tremendo.
    const scaledWidth = metadata.width * 2;
    const scaledHeight = metadata.height * 2;
    const frames = Math.max(1, Math.ceil(perImage * metadata.fps));
    const segmentPaths: string[] = [];
    activeJobs.set(id, { status: "encoding", timeSec: 0, fps: 0, speed: "1x" });
    console.log(
      `[render-service] job=${id} iniciando ${imagePaths.length} segmentos em ${metadata.width}x${metadata.height}@${metadata.fps}`,
    );

    for (let index = 0; index < imagePaths.length; index += 1) {
      const segmentPath = path.join(workDir, `segment-${String(index).padStart(3, "0")}.mp4`);
      const base = `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,crop=${scaledWidth}:${scaledHeight}`;
      const motion = metadata.kenBurns
        ? `,zoompan=z='1+0.04*on/${Math.max(1, frames - 1)}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${frames}:s=${metadata.width}x${metadata.height}:fps=${metadata.fps}`
        : `,scale=${metadata.width}:${metadata.height}`;
      const segmentArgs = [
        "-y",
        "-loop",
        "1",
        "-framerate",
        String(metadata.fps),
        "-i",
        imagePaths[index]!,
        "-vf",
        `${base}${motion},setsar=1,format=yuv420p`,
        "-frames:v",
        String(frames),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "0",
        segmentPath,
      ];
      await runFfmpeg(segmentArgs, id, (seconds) => {
        const job = activeJobs.get(id);
        if (job) {
          const completed = index * perImage + Math.min(perImage, seconds);
          job.timeSec = Math.max(job.timeSec, completed * 0.5);
        }
      });
      segmentPaths.push(segmentPath);
      const job = activeJobs.get(id);
      if (job) job.timeSec = ((index + 1) * perImage) / 2;
      console.log(`[render-service] job=${id} segmento ${index + 1}/${images.length} concluído`);
    }

    const concatListPath = path.join(workDir, "segments.txt");
    const concatList = segmentPaths
      .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.writeFile(concatListPath, `${concatList}\n`, "utf8");
    const visualsPath = path.join(workDir, "visuals.mp4");
    await runFfmpeg(
      ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", visualsPath],
      id,
      () => {},
    );

    const args: string[] = ["-y", "-i", visualsPath, "-i", narrationPath];
    if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
    const filters: string[] = [];
    if (metadata.captions?.length) {
      filters.push(`[0:v]subtitles=filename='${escapeFilterPath(assPath)}'[videoout]`);
    } else {
      filters.push("[0:v]null[videoout]");
    }
    if (musicPath) {
      const fadeStart = Math.max(0, metadata.duration - 2);
      filters.push(`[1:a]volume=${metadata.narrationVolume}[narr]`);
      filters.push(
        `[2:a]volume=${metadata.musicVolume},atrim=0:${metadata.duration},afade=t=out:st=${fadeStart}:d=2[music]`,
      );
      filters.push("[narr][music]amix=inputs=2:duration=first:dropout_transition=0[audioout]");
    } else {
      filters.push(`[1:a]volume=${metadata.narrationVolume}[audioout]`);
    }
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[videoout]",
      "-map",
      "[audioout]",
      "-t",
      String(metadata.duration),
    );
    if (metadata.format === "webm") {
      args.push(
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        "-b:v",
        "0",
        "-crf",
        "30",
        "-c:a",
        "libopus",
      );
    } else {
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
      );
    }
    args.push("-threads", "0", outputPath);
    console.log(`[render-service] job=${id} aplicando áudio e legendas`);
    await runFfmpeg(args, id, (seconds) => {
      const job = activeJobs.get(id);
      if (job) {
        job.timeSec = Math.max(
          job.timeSec,
          metadata.duration * 0.5 + Math.min(metadata.duration, seconds) * 0.5,
        );
      }
    });
    const output = await fs.readFile(outputPath);
    activeJobs.set(id, {
      status: "done",
      timeSec: metadata.duration,
      fps: metadata.fps,
      speed: "1x",
    });
    return new Response(output, {
      headers: {
        "Content-Type": metadata.format === "webm" ? "video/webm" : "video/mp4",
        "Content-Length": String(output.length),
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha na montagem do vídeo.";
    activeJobs.set(id, { status: "error", timeSec: 0, fps: 0, speed: "0x", error: message });
    console.error("[render-service]", error);
    return Response.json({ error: message }, { status: 500 });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    setTimeout(() => activeJobs.delete(id), 15000);
  }
}
