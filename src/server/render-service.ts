import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
        return `{\\kf${duration}}${assText(word)}`;
      })
      .join(" ");
    return `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,${karaoke}`;
  });
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,${fontSize},&H003FD2FF,&H00E8E8E8,&H00101010,&H70000000,-1,0,0,0,100,100,0,0,3,5,0,2,80,80,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

function parseTime(value: string): number {
  const parts = value.split(":").map(Number);
  return parts.length === 3 ? (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0) : 0;
}

async function runFfmpeg(args: string[], jobId: string): Promise<void> {
  const binary = getFfmpegPath();
  if (!binary) throw new Error("FFmpeg nativo não está disponível no servidor.");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-16000);
      const match = text.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
      if (match?.[1]) {
        const job = activeJobs.get(jobId);
        if (job) job.timeSec = parseTime(match[1]);
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
  const idParam = new URL(request.url).searchParams.get("id") || "";
  const id = /^[a-zA-Z0-9-]{1,64}$/.test(idParam) ? idParam : randomUUID();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `studio-render-${id}-`));
  activeJobs.set(id, { status: "uploading", timeSec: 0, fps: 0, speed: "0x" });
  try {
    const form = await request.formData();
    const metadata = validateMetadata(
      JSON.parse(String(form.get("metadata") || "{}")),
      form.get("duration"),
    );
    const images = form.getAll("images").filter((value): value is File => value instanceof File);
    const narration = form.get("narration");
    const music = form.get("music");
    if (!images.length || !(narration instanceof File)) {
      throw new Error("Imagens ou narração não foram recebidas pelo servidor.");
    }
    if (images.length > 200) throw new Error("O limite é de 200 imagens por vídeo.");

    const imagePaths: string[] = [];
    for (let index = 0; index < images.length; index += 1) {
      const file = images[index]!;
      const filePath = path.join(
        workDir,
        `image-${String(index).padStart(3, "0")}${extensionFor(file, ".img")}`,
      );
      await fs.writeFile(filePath, Buffer.from(await file.arrayBuffer()));
      imagePaths.push(filePath);
    }
    const narrationPath = path.join(workDir, `narration${extensionFor(narration, ".audio")}`);
    await fs.writeFile(narrationPath, Buffer.from(await narration.arrayBuffer()));
    let musicPath: string | null = null;
    if (music instanceof File && music.size > 0) {
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
    const perImage = metadata.duration / images.length;
    const fade = images.length > 1 ? Math.min(metadata.fade, perImage / 4) : 0;
    const segmentDuration = perImage + fade;
    const args: string[] = ["-y"];
    imagePaths.forEach((imagePath) => {
      args.push(
        "-loop",
        "1",
        "-framerate",
        String(metadata.fps),
        "-t",
        String(segmentDuration),
        "-i",
        imagePath,
      );
    });
    args.push("-i", narrationPath);
    if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);

    const filters: string[] = [];
    const scaledWidth = Math.ceil((metadata.width * 1.08) / 2) * 2;
    const scaledHeight = Math.ceil((metadata.height * 1.08) / 2) * 2;
    const frames = Math.max(1, Math.ceil(segmentDuration * metadata.fps));
    imagePaths.forEach((_, index) => {
      const base = `[${index}:v]scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,crop=${scaledWidth}:${scaledHeight}`;
      const motion = metadata.kenBurns
        ? `,zoompan=z='min(zoom+${(0.06 / frames).toFixed(8)},1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${metadata.width}x${metadata.height}:fps=${metadata.fps}`
        : `,scale=${metadata.width}:${metadata.height}`;
      filters.push(`${base}${motion},setsar=1,format=yuv420p[v${index}]`);
    });
    let videoLabel = "v0";
    for (let index = 1; index < images.length; index += 1) {
      const nextLabel = `vx${index}`;
      filters.push(
        `[${videoLabel}][v${index}]xfade=transition=fade:duration=${fade || 0.001}:offset=${(index * perImage).toFixed(6)}[${nextLabel}]`,
      );
      videoLabel = nextLabel;
    }
    if (metadata.captions?.length) {
      filters.push(`[${videoLabel}]subtitles=filename='${escapeFilterPath(assPath)}'[videoout]`);
      videoLabel = "videoout";
    }
    const narrationIndex = images.length;
    if (musicPath) {
      const musicIndex = narrationIndex + 1;
      const fadeStart = Math.max(0, metadata.duration - 2);
      filters.push(`[${narrationIndex}:a]volume=${metadata.narrationVolume}[narr]`);
      filters.push(
        `[${musicIndex}:a]volume=${metadata.musicVolume},atrim=0:${metadata.duration},afade=t=out:st=${fadeStart}:d=2[music]`,
      );
      filters.push("[narr][music]amix=inputs=2:duration=first:dropout_transition=0[audioout]");
    } else {
      filters.push(`[${narrationIndex}:a]volume=${metadata.narrationVolume}[audioout]`);
    }
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      `[${videoLabel}]`,
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
    activeJobs.set(id, { status: "encoding", timeSec: 0, fps: 0, speed: "1x" });
    await runFfmpeg(args, id);
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
