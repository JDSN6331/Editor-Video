import type { Caption, CaptionWord } from "./types";

export interface AudioTranscription {
  text: string;
  language: string | null;
  duration: number;
  words: CaptionWord[];
}

const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

function joinWords(words: readonly CaptionWord[]): string {
  return words
    .map((word) => word.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:!?%)}\]])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .trim();
}

function shouldSplitBefore(
  current: readonly CaptionWord[],
  next: CaptionWord,
  maxChars: number,
): boolean {
  if (!current.length) return false;
  const currentText = joinWords(current);
  const candidate = joinWords([...current, next]);
  const previous = current[current.length - 1]!;
  const pause = next.start - previous.end;
  const enoughText = currentText.length >= Math.min(24, Math.round(maxChars * 0.35));
  const endedSentence = /[.!?]["'»)]?$/.test(previous.text.trim());

  return (
    candidate.length > maxChars ||
    (pause >= 0.85 && enoughText) ||
    (endedSentence && currentText.length >= Math.round(maxChars * 0.55))
  );
}

/** Agrupa palavras transcritas sem perder os timestamps retornados pelo reconhecimento. */
export function captionsFromTranscription(
  inputWords: readonly CaptionWord[],
  maxChars = 90,
): Caption[] {
  const limit = Math.max(10, Math.round(maxChars));
  const words = inputWords
    .filter(
      (word) =>
        word.text.trim() &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start,
    )
    .map((word) => ({
      text: word.text.trim(),
      start: Math.max(0, word.start),
      end: Math.max(0, word.end),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const captions: Caption[] = [];
  let block: CaptionWord[] = [];

  const flush = () => {
    if (!block.length) return;
    const first = block[0]!;
    const last = block[block.length - 1]!;
    captions.push({
      start: Number(first.start.toFixed(3)),
      end: Number(last.end.toFixed(3)),
      text: joinWords(block),
      words: block.map((word) => ({ ...word })),
    });
    block = [];
  };

  for (const word of words) {
    if (shouldSplitBefore(block, word, limit)) flush();
    block.push(word);
  }
  flush();
  return captions;
}

function dataUrlToBlob(source: string): Blob {
  const separator = source.indexOf(",");
  if (separator < 0) throw new Error("Áudio salvo em formato inválido.");
  const header = source.slice(0, separator);
  const content = source.slice(separator + 1);
  const mimeType = header.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  if (!header.includes(";base64")) {
    return new Blob([decodeURIComponent(content)], { type: mimeType });
  }
  const decoded = atob(content);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function getAudioBlob(audio: { blob?: Blob; dataUrl?: string; url: string }): Promise<Blob> {
  if (audio.blob) return audio.blob;
  if (audio.dataUrl?.startsWith("data:")) return dataUrlToBlob(audio.dataUrl);
  if (audio.url.startsWith("data:")) return dataUrlToBlob(audio.url);
  const response = await fetch(audio.url);
  if (!response.ok) throw new Error("Não foi possível preparar a narração para transcrição.");
  return response.blob();
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `Falha na transcrição (HTTP ${response.status}).`;
  } catch {
    return `Falha na transcrição (HTTP ${response.status}).`;
  }
}

export async function transcribeAudio(audio: {
  name: string;
  blob?: Blob;
  dataUrl?: string;
  url: string;
}): Promise<AudioTranscription> {
  const blob = await getAudioBlob(audio);
  if (blob.size > TRANSCRIPTION_MAX_BYTES) {
    throw new Error("A narração ultrapassa o limite de 25 MB para transcrição.");
  }

  const query = new URLSearchParams({ name: audio.name });
  const response = await fetch(`/api/transcribe?${query}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) throw new Error(await readError(response));

  const payload = (await response.json()) as Partial<AudioTranscription>;
  const words = Array.isArray(payload.words) ? payload.words : [];
  if (!words.length) {
    throw new Error("O serviço não encontrou fala reconhecível na narração.");
  }
  return {
    text: String(payload.text || ""),
    language: typeof payload.language === "string" ? payload.language : null,
    duration: Number(payload.duration) || 0,
    words,
  };
}
