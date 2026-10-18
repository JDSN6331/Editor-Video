import type { Caption } from "./types";

/** Quebra o roteiro em blocos curtos de legenda. */
export function splitScript(script: string, maxChars = 90): string[] {
  const sentences = script
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…:;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const blocks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      blocks.push(sentence);
      continue;
    }
    const words = sentence.split(" ");
    let current = "";
    for (const word of words) {
      if ((current + " " + word).trim().length > maxChars) {
        if (current) blocks.push(current.trim());
        current = word;
      } else {
        current = (current + " " + word).trim();
      }
    }
    if (current) blocks.push(current.trim());
  }
  return blocks;
}

/**
 * Distribui os blocos de legenda ao longo da duração da narração,
 * proporcionalmente à quantidade de caracteres de cada bloco.
 */
export function buildCaptions(script: string, duration: number, maxChars = 90): Caption[] {
  const blocks = splitScript(script, maxChars);
  if (!blocks.length || duration <= 0) return [];
  const totalChars = blocks.reduce((sum, b) => sum + b.length, 0);
  let cursor = 0;
  return blocks.map((text, i) => {
    const slice = (text.length / totalChars) * duration;
    const start = cursor;
    cursor = i === blocks.length - 1 ? duration : cursor + slice;
    return { start, end: cursor, text };
  });
}

export function formatTime(seconds: number, ms = false): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalMillis = Math.round(s * 1000);
  const wholeSeconds = ms ? Math.floor(totalMillis / 1000) : Math.floor(s);
  const h = Math.floor(wholeSeconds / 3600);
  const m = Math.floor((wholeSeconds % 3600) / 60);
  const sec = wholeSeconds % 60;
  const millis = totalMillis % 1000;
  const base = `${h > 0 ? String(h).padStart(2, "0") + ":" : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return ms ? `${base},${String(millis).padStart(3, "0")}` : base;
}

function srtTime(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalMillis = Math.round(s * 1000);
  const wholeSeconds = Math.floor(totalMillis / 1000);
  const h = Math.floor(wholeSeconds / 3600);
  const m = Math.floor((wholeSeconds % 3600) / 60);
  const sec = wholeSeconds % 60;
  const millis = totalMillis % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function toSRT(captions: Caption[]): string {
  return captions
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");
}
