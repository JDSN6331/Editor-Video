const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

interface OpenAITranscriptionWord {
  word?: unknown;
  start?: unknown;
  end?: unknown;
}

interface OpenAITranscriptionResponse {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  words?: unknown;
  error?: { message?: unknown };
}

export interface TranscriptionResponse {
  text: string;
  language: string | null;
  duration: number;
  words: Array<{ text: string; start: number; end: number }>;
}

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function safeAudioName(value: string): string {
  const printable = Array.from(value, (character) =>
    character.charCodeAt(0) < 32 ? "_" : character,
  ).join("");
  const name = printable
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 180);
  return name || "narracao.mp3";
}

function normalizeWords(value: unknown): TranscriptionResponse["words"] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100_000)
    .map((item) => {
      const word = (item ?? {}) as OpenAITranscriptionWord;
      return {
        text: String(word.word || "").trim(),
        start: Number(word.start),
        end: Number(word.end),
      };
    })
    .filter(
      (word) =>
        word.text &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.start >= 0 &&
        word.end > word.start,
    );
}

export async function transcribeAudioBytes(
  bytes: Uint8Array,
  originalName: string,
  contentType: string,
): Promise<TranscriptionResponse> {
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) {
    throw httpError(
      "A transcrição profissional ainda não foi configurada no servidor. Defina OPENAI_API_KEY.",
      503,
    );
  }
  if (!bytes.byteLength) throw httpError("O arquivo de narração está vazio.", 400);
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw httpError("A narração ultrapassa o limite de 25 MB para transcrição.", 413);
  }

  const audioBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(audioBuffer).set(bytes);
  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBuffer], { type: contentType || "application/octet-stream" }),
    safeAudioName(originalName),
  );
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const language = process.env["OPENAI_TRANSCRIPTION_LANGUAGE"]?.trim();
  if (language) form.append("language", language);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch {
    throw httpError("O servidor não conseguiu acessar o serviço de transcrição.", 502);
  }

  const payload = (await response.json().catch(() => ({}))) as OpenAITranscriptionResponse;
  if (!response.ok) {
    const providerMessage =
      typeof payload.error?.message === "string" ? payload.error.message : "erro não informado";
    console.error(`[transcription-api] OpenAI HTTP ${response.status}: ${providerMessage}`);
    if (response.status === 401 || response.status === 403) {
      throw httpError("A chave de transcrição configurada no servidor é inválida.", 503);
    }
    if (response.status === 429) {
      throw httpError(
        "O limite do serviço de transcrição foi atingido. Tente novamente em instantes.",
        429,
      );
    }
    throw httpError("O serviço de transcrição não conseguiu processar esta narração.", 502);
  }

  const words = normalizeWords(payload.words);
  if (!words.length) {
    throw httpError("Nenhuma fala reconhecível foi encontrada na narração.", 422);
  }
  return {
    text: String(payload.text || "").trim(),
    language: typeof payload.language === "string" ? payload.language : null,
    duration: Number(payload.duration) || words[words.length - 1]!.end,
    words,
  };
}

export async function handleFetchTranscription(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: "A narração ultrapassa o limite de 25 MB." }, { status: 413 });
  }
  const url = new URL(request.url);
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result = await transcribeAudioBytes(
      bytes,
      url.searchParams.get("name") || "narracao.mp3",
      request.headers.get("content-type") || "application/octet-stream",
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = Number((error as { status?: unknown }).status) || 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "Falha na transcrição." },
      { status },
    );
  }
}
