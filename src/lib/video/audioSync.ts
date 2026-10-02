import type { Caption } from "./types";
import { splitScript } from "./captions";

export interface SpeechSegment {
  start: number;
  end: number;
  duration: number;
}

export interface PauseSegment {
  start: number;
  end: number;
  duration: number;
}

export interface AudioAnalysisResult {
  segments: SpeechSegment[];
  pauses: PauseSegment[];
  totalSpeechSec: number;
  duration: number;
}

export interface VADOptions {
  /** Janela de amostragem em ms (padrão: 30ms) */
  windowMs?: number;
  /** Limiar de sensibilidade de 0 a 1 (padrão: 0.12). Menor = mais sensível à fala fraca */
  sensitivity?: number;
  /** Duração mínima de silêncio para considerar uma pausa real (padrão: 0.35s) */
  minSilenceSec?: number;
  /** Duração mínima de fala para descartar estalos/ruídos isolados (padrão: 0.20s) */
  minSpeechSec?: number;
  /** Preenchimento (padding) antes e depois da fala para não cortar palavras (padrão: 0.08s) */
  padSec?: number;
}

/**
 * Analisa o AudioBuffer da narração usando Web Audio API (offline e instantâneo).
 * Detecta quando há fala ativa e quando há pausas reais de silêncio.
 */
export function analyzeAudioSpeech(
  buffer: AudioBuffer,
  options: VADOptions = {},
): AudioAnalysisResult {
  const {
    windowMs = 30,
    sensitivity = 0.12,
    minSilenceSec = 0.35,
    minSpeechSec = 0.2,
    padSec = 0.08,
  } = options;

  const duration = buffer.duration;
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const totalSamples = buffer.length;

  if (duration <= 0 || totalSamples === 0) {
    return { segments: [], pauses: [], totalSpeechSec: 0, duration: 0 };
  }

  const windowSize = Math.max(64, Math.floor((sampleRate * windowMs) / 1000));
  const numWindows = Math.floor(totalSamples / windowSize);

  // Canais de áudio
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    channelData.push(buffer.getChannelData(c));
  }

  // 1. Calcula o RMS (Root Mean Square) de cada janela
  const rmsValues = new Float32Array(numWindows);
  let maxRms = 0;

  for (let w = 0; w < numWindows; w++) {
    const offset = w * windowSize;
    let sumSquares = 0;

    for (let i = 0; i < windowSize; i++) {
      let sampleVal = 0;
      for (let c = 0; c < channels; c++) {
        const chan = channelData[c];
        if (chan) {
          sampleVal += chan[offset + i] || 0;
        }
      }
      sampleVal /= channels;
      sumSquares += sampleVal * sampleVal;
    }

    const rms = Math.sqrt(sumSquares / windowSize);
    rmsValues[w] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // Se o áudio for completamente mudo
  if (maxRms < 0.0001) {
    return {
      segments: [{ start: 0, end: duration, duration }],
      pauses: [],
      totalSpeechSec: duration,
      duration,
    };
  }

  // 2. Estima o piso de ruído (noise floor) usando percentil ~25
  const sampleStep = Math.max(1, Math.floor(numWindows / 500));
  const sampledRms: number[] = [];
  for (let w = 0; w < numWindows; w += sampleStep) {
    const val = rmsValues[w];
    if (val !== undefined) {
      sampledRms.push(val);
    }
  }
  sampledRms.sort((a, b) => a - b);
  const noiseFloor = sampledRms[Math.floor(sampledRms.length * 0.25)] ?? 0;
  const speechPeak = sampledRms[Math.floor(sampledRms.length * 0.9)] ?? maxRms;

  // Limiar adaptativo de fala
  const threshold = Math.max(0.008, noiseFloor + (speechPeak - noiseFloor) * sensitivity);

  // 3. Classificação inicial de cada janela
  const isSpeech = new Uint8Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const val = rmsValues[w];
    if (val !== undefined && val >= threshold) {
      isSpeech[w] = 1;
    }
  }

  // 4. Suavização: silêncios menores que minSilenceSec são considerados parte da fala
  const minSilenceWindows = Math.floor((minSilenceSec * 1000) / windowMs);
  let silenceCount = 0;
  let lastSpeechIdx = -1;

  for (let w = 0; w < numWindows; w++) {
    if (isSpeech[w] === 1) {
      if (lastSpeechIdx !== -1 && silenceCount > 0 && silenceCount < minSilenceWindows) {
        // Preenche o silêncio curto com fala (micro-pausa de respiração ou consoante oclusiva)
        for (let k = lastSpeechIdx + 1; k < w; k++) {
          isSpeech[k] = 1;
        }
      }
      lastSpeechIdx = w;
      silenceCount = 0;
    } else {
      silenceCount++;
    }
  }

  // 5. Agrupa em segmentos de fala e pausas
  const minSpeechWindows = Math.floor((minSpeechSec * 1000) / windowMs);
  const rawSegments: { startWindow: number; endWindow: number }[] = [];
  let inSpeech = false;
  let segStart = 0;

  for (let w = 0; w < numWindows; w++) {
    if (isSpeech[w] === 1 && !inSpeech) {
      inSpeech = true;
      segStart = w;
    } else if (isSpeech[w] === 0 && inSpeech) {
      inSpeech = false;
      if (w - segStart >= minSpeechWindows) {
        rawSegments.push({ startWindow: segStart, endWindow: w });
      }
    }
  }
  if (inSpeech && numWindows - segStart >= minSpeechWindows) {
    rawSegments.push({ startWindow: segStart, endWindow: numWindows });
  }

  if (rawSegments.length === 0) {
    return {
      segments: [{ start: 0, end: duration, duration }],
      pauses: [],
      totalSpeechSec: duration,
      duration,
    };
  }

  // Converte janelas em segundos com padding cuidadoso
  const segments: SpeechSegment[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];
    if (!raw) continue;
    let start = Math.max(0, (raw.startWindow * windowMs) / 1000 - padSec);
    const end = Math.min(duration, (raw.endWindow * windowMs) / 1000 + padSec);

    // Evita sobreposição com segmento anterior
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && start < lastSeg.end) {
      start = lastSeg.end;
    }

    if (end > start) {
      segments.push({ start, end, duration: end - start });
    }
  }

  // Identifica as pausas reais entre os segmentos
  const pauses: PauseSegment[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const curr = segments[i];
    const next = segments[i + 1];
    if (!curr || !next) continue;
    const pStart = curr.end;
    const pEnd = next.start;
    const pDuration = pEnd - pStart;
    if (pDuration >= minSilenceSec) {
      pauses.push({ start: pStart, end: pEnd, duration: pDuration });
    }
  }

  const totalSpeechSec = segments.reduce((acc, s) => acc + s.duration, 0);

  return { segments, pauses, totalSpeechSec, duration };
}

/**
 * Mapeia um tempo virtual de fala (contínuo) para o tempo real no áudio
 * que pula todos os momentos de silêncio e pausas.
 */
function virtualSpeechToRealTime(vTime: number, segments: SpeechSegment[]): number {
  let remaining = Math.max(0, vTime);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    if (remaining <= seg.duration) {
      return seg.start + remaining;
    }
    remaining -= seg.duration;
  }
  const lastSeg = segments[segments.length - 1];
  return lastSeg ? lastSeg.end : vTime;
}

/**
 * Cria legendas sincronizadas com o áudio, respeitando pausas da narração.
 * Durante pausas longas do narrador, a legenda anterior é encerrada e a próxima
 * só começa quando o narrador retoma a fala.
 */
export function buildAudioSyncedCaptions(
  script: string,
  buffer: AudioBuffer | null,
  duration: number,
  maxChars = 90,
  options?: VADOptions,
): { captions: Caption[]; pausesCount: number } {
  const blocks = splitScript(script, maxChars);
  if (!blocks.length || duration <= 0) {
    return { captions: [], pausesCount: 0 };
  }

  // Se não temos o buffer de áudio decodificado, usa fallback proporcional
  if (!buffer) {
    const totalChars = blocks.reduce((sum, b) => sum + b.length, 0);
    let cursor = 0;
    const captions = blocks.map((text, i) => {
      const slice = (text.length / totalChars) * duration;
      const start = cursor;
      cursor = i === blocks.length - 1 ? duration : cursor + slice;
      return { start, end: cursor, text };
    });
    return { captions, pausesCount: 0 };
  }

  // Analisa fala e pausas no áudio
  const analysis = analyzeAudioSpeech(buffer, options);
  const { segments, pauses, totalSpeechSec } = analysis;

  if (segments.length === 0 || totalSpeechSec <= 0) {
    // Fallback proporcional
    const totalChars = blocks.reduce((sum, b) => sum + b.length, 0);
    let cursor = 0;
    const captions = blocks.map((text, i) => {
      const slice = (text.length / totalChars) * duration;
      const start = cursor;
      cursor = i === blocks.length - 1 ? duration : cursor + slice;
      return { start, end: cursor, text };
    });
    return { captions, pausesCount: 0 };
  }

  // Distribui os blocos proporcionalmente APENAS sobre o tempo de fala ativa
  const totalChars = blocks.reduce((sum, b) => sum + b.length, 0);
  let vCursor = 0;

  const captions: Caption[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const text = blocks[i] ?? "";
    const isLast = i === blocks.length - 1;
    const vSlice = (text.length / totalChars) * totalSpeechSec;

    const vStart = vCursor;
    const vEnd = isLast ? totalSpeechSec : vCursor + vSlice;
    vCursor = vEnd;

    let realStart = virtualSpeechToRealTime(vStart, segments);
    let realEnd = virtualSpeechToRealTime(vEnd, segments);

    // Ajusta limites para respeitar pausas naturais:
    for (const pause of pauses) {
      if (realEnd >= pause.start - 0.25 && realEnd <= pause.end) {
        realEnd = pause.start;
      }
      if (realStart >= pause.start && realStart <= pause.end + 0.15) {
        realStart = pause.end;
      }
    }

    if (realEnd <= realStart) {
      realEnd = realStart + Math.max(0.5, (text.length / totalChars) * 1.5);
    }

    captions.push({
      start: Number(realStart.toFixed(3)),
      end: Number(Math.min(duration, realEnd).toFixed(3)),
      text,
    });
  }

  // Refina transições entre blocos adjacentes
  for (let i = 0; i < captions.length - 1; i++) {
    const curr = captions[i];
    const next = captions[i + 1];
    if (!curr || !next) continue;

    if (next.start < curr.end) {
      const mid = (curr.end + next.start) / 2;
      curr.end = Number(mid.toFixed(3));
      next.start = Number(mid.toFixed(3));
    }
  }

  return { captions, pausesCount: pauses.length };
}
