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

export interface SceneSpeechRange {
  start: number;
  end: number;
  speechStart?: number;
  speechEnd?: number;
}

export interface AudioSyncOptions extends VADOptions {
  /** Limites detectados das cenas usados para impedir que texto/legenda atravesse uma pausa. */
  sceneRanges?: readonly SceneSpeechRange[];
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
    minSilenceSec = 0.3,
    minSpeechSec = 0.2,
    padSec = 0.05,
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
  const windowDurationSec = windowSize / sampleRate;

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
      let channelSquares = 0;
      for (let c = 0; c < channels; c++) {
        const chan = channelData[c];
        if (chan) {
          const sample = chan[offset + i] || 0;
          channelSquares += sample * sample;
        }
      }
      // Mede a energia de cada canal antes da média. Somar as amplitudes primeiro
      // pode cancelar uma voz estéreo com canais em polaridade oposta.
      sumSquares += channelSquares / channels;
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
  const minSilenceWindows = Math.ceil(minSilenceSec / windowDurationSec);
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
  const minSpeechWindows = Math.ceil(minSpeechSec / windowDurationSec);
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
    // Pré-roll curto aproxima a legenda do ataque real da primeira palavra.
    let start = Math.max(0, raw.startWindow * windowDurationSec - padSec * 0.4);
    const end = Math.min(duration, raw.endWindow * windowDurationSec + padSec);

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

/** Aproxima a duração falada por núcleos vocálicos, mais fiel que nº de caracteres. */
function estimateSpeechUnits(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(
    1,
    words.reduce((total, word) => {
      const vowelGroups = word.match(/[aeiouáéíóúâêôãõàü]+/gi)?.length ?? 0;
      return total + Math.max(1, vowelGroups) + 0.12;
    }, 0),
  );
}

function boundaryStrength(word: string): number {
  const withoutClosers = word.replace(/["'”’»)\]}]+$/g, "");
  if (/[.!?…]$/.test(withoutClosers)) return 1;
  if (/[;:]$/.test(withoutClosers)) return 0.7;
  if (/[,]$/.test(withoutClosers)) return 0.4;
  return 0;
}

function speechRangeDuration(range: SceneSpeechRange): number {
  const start = range.speechStart ?? range.start;
  const end = range.speechEnd ?? range.end;
  return Math.max(0.05, end - start);
}

/**
 * Divide o roteiro uma única vez e em ordem entre as cenas detectadas.
 *
 * Cada palavra pertence a exatamente uma cena. A duração falada define a posição
 * aproximada e a pontuação próxima funciona como âncora para as pausas do locutor.
 * Isso evita o comportamento anterior de atribuir blocos inteiros pelo ponto médio
 * ou repartir frases igualmente entre cenas de durações muito diferentes.
 */
export function alignScriptToScenes(
  script: string,
  sceneRanges: readonly SceneSpeechRange[],
): string[] {
  if (!sceneRanges.length) return [];

  const words = script.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return sceneRanges.map(() => "");

  const wordUnits = words.map(estimateSpeechUnits);
  const prefixUnits = new Array<number>(words.length + 1).fill(0);
  for (let i = 0; i < wordUnits.length; i++) {
    prefixUnits[i + 1] = prefixUnits[i]! + wordUnits[i]!;
  }

  const totalUnits = prefixUnits.at(-1) ?? 0;
  const sceneDurations = sceneRanges.map(speechRangeDuration);
  const totalSceneDuration = sceneDurations.reduce((sum, value) => sum + value, 0);
  const canFillEveryScene = words.length >= sceneRanges.length;
  const boundaries: number[] = [0];
  let consumedDuration = 0;
  let previousBoundary = 0;

  for (let sceneIndex = 0; sceneIndex < sceneRanges.length - 1; sceneIndex++) {
    // Recalcula a velocidade com o texto e o áudio que ainda restam. Assim um
    // pequeno erro anterior é diluído pelas cenas seguintes, em vez de adiantar
    // uma frase inteira para compensar tudo na próxima fronteira.
    const remainingDuration = Math.max(0.05, totalSceneDuration - consumedDuration);
    const remainingUnits = Math.max(1, totalUnits - prefixUnits[previousBoundary]!);
    const expectedSceneUnits = Math.max(
      1,
      (sceneDurations[sceneIndex]! / remainingDuration) * remainingUnits,
    );
    const targetUnits = prefixUnits[previousBoundary]! + expectedSceneUnits;
    const remainingScenes = sceneRanges.length - sceneIndex - 1;
    const minBoundary = Math.min(words.length, previousBoundary + (canFillEveryScene ? 1 : 0));
    const maxBoundary = Math.max(
      minBoundary,
      words.length - (canFillEveryScene ? remainingScenes : 0),
    );
    let bestBoundary = minBoundary;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let boundary = minBoundary; boundary <= maxBoundary; boundary++) {
      const distance = Math.abs(prefixUnits[boundary]! - targetUnits) / expectedSceneUnits;
      const punctuation = boundary > 0 ? boundaryStrength(words[boundary - 1]!) : 0;
      // A pontuação só influencia âncoras razoavelmente próximas do tempo esperado;
      // assim uma frase muito longa não desloca todas as cenas seguintes.
      const punctuationBonus = distance <= 0.45 ? punctuation * 0.22 : 0;
      const score = distance - punctuationBonus;
      if (score < bestScore) {
        bestScore = score;
        bestBoundary = boundary;
      }
    }

    boundaries.push(bestBoundary);
    previousBoundary = bestBoundary;
    consumedDuration += sceneDurations[sceneIndex]!;
  }
  boundaries.push(words.length);

  return sceneRanges.map((_, index) =>
    words
      .slice(boundaries[index]!, boundaries[index + 1]!)
      .join(" ")
      .trim(),
  );
}

/** Gera legendas que nunca ultrapassam o intervalo de fala da respectiva cena. */
export function buildSceneAlignedCaptions(
  script: string,
  sceneRanges: readonly SceneSpeechRange[],
  maxChars = 90,
): { captions: Caption[]; sceneTexts: string[] } {
  const sceneTexts = alignScriptToScenes(script, sceneRanges);
  const captions: Caption[] = [];

  sceneTexts.forEach((sceneText, sceneIndex) => {
    const range = sceneRanges[sceneIndex];
    if (!range || !sceneText) return;

    const start = range.speechStart ?? range.start;
    const end = range.speechEnd ?? range.end;
    if (end <= start) return;

    const blocks = splitScript(sceneText, maxChars);
    const blockUnits = blocks.map(estimateSpeechUnits);
    const totalBlockUnits = blockUnits.reduce((sum, value) => sum + value, 0);
    let cursor = start;

    blocks.forEach((text, blockIndex) => {
      const isLast = blockIndex === blocks.length - 1;
      const blockEnd = isLast
        ? end
        : cursor + ((blockUnits[blockIndex] ?? 1) / totalBlockUnits) * (end - start);
      captions.push({
        start: Number(cursor.toFixed(3)),
        end: Number(blockEnd.toFixed(3)),
        text,
      });
      cursor = blockEnd;
    });
  });

  return { captions, sceneTexts };
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
  options?: AudioSyncOptions,
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
  const { sceneRanges, ...vadOptions } = options ?? {};
  const analysis = analyzeAudioSpeech(buffer, vadOptions);
  const { segments, pauses, totalSpeechSec } = analysis;

  if (sceneRanges?.length) {
    const aligned = buildSceneAlignedCaptions(script, sceneRanges, maxChars);
    if (aligned.captions.length > 0) {
      return { captions: aligned.captions, pausesCount: pauses.length };
    }
  }

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

  // Distribui pelo tempo de fala usando uma aproximação silábica. Palavras longas
  // deixam de receber tempo excessivo apenas por terem mais caracteres.
  const speechUnits = blocks.map(estimateSpeechUnits);
  const totalUnits = speechUnits.reduce((sum, units) => sum + units, 0);
  let vCursor = 0;

  const captions: Caption[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const text = blocks[i] ?? "";
    const isLast = i === blocks.length - 1;
    const vSlice = ((speechUnits[i] ?? 1) / totalUnits) * totalSpeechSec;

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
      realEnd = realStart + Math.max(0.5, ((speechUnits[i] ?? 1) / totalUnits) * 1.5);
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

    const averageBlockDuration = totalSpeechSec / Math.max(1, blocks.length);
    const snapWindow = Math.max(0.75, Math.min(2.5, averageBlockDuration * 0.45));
    const nearbyPause = pauses
      .filter(
        (pause) =>
          pause.start > curr.start + 0.2 &&
          pause.end < next.end - 0.2 &&
          Math.abs((pause.start + pause.end) / 2 - next.start) <= snapWindow,
      )
      .sort(
        (a, b) =>
          Math.abs((a.start + a.end) / 2 - next.start) -
          Math.abs((b.start + b.end) / 2 - next.start),
      )[0];

    if (nearbyPause) {
      curr.end = Number(nearbyPause.start.toFixed(3));
      next.start = Number(nearbyPause.end.toFixed(3));
    } else if (next.start < curr.end) {
      const mid = (curr.end + next.start) / 2;
      curr.end = Number(mid.toFixed(3));
      next.start = Number(mid.toFixed(3));
    }
  }

  return { captions, pausesCount: pauses.length };
}
