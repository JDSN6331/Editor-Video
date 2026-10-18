import type { Caption } from "./types";
import { analyzeAudioSpeech, type VADOptions } from "./audioSync";
import { splitScript } from "./captions";

/**
 * Uma cena é uma mídia (imagem/vídeo) e o intervalo exato da narração em que ela
 * fica em tela. As cenas são contíguas: a cena N termina exatamente onde a cena
 * N+1 começa, então uma cena nunca invade o trecho de outra.
 */
export interface Scene {
  start: number;
  end: number;
  duration: number;
  speechStart?: number;
  speechEnd?: number;
  pauseAfter?: number;
}

/**
 * Cena detectada a partir da própria narração (análise de áudio e pausas).
 */
export interface DetectedNarrationScene extends Scene {
  index: number;
  start: number;
  end: number;
  duration: number;
  speechStart: number;
  speechEnd: number;
  pauseAfter: number;
}

/**
 * Opções de detecção de cenas na narração.
 */
export interface DetectScenesOptions extends VADOptions {
  /** Pausa mínima entre falas para qualificar como quebra de cena (padrão: 0.45s). */
  minPauseSec?: number;
  /** Duração mínima para cada cena (padrão: 2.0s). */
  minSceneDurationSec?: number;
  /** Duração máxima de uma cena antes de permitir corte em pausas menores (padrão: 25.0s). */
  maxSceneDurationSec?: number;
}

/** Duração mínima de uma cena para evitar quadros piscando. */
const MIN_SCENE_SECONDS = 0.1;

/** Padrões compartilhados pela detecção e pelos controles da interface. */
export const DEFAULT_SCENE_MIN_PAUSE_SEC = 0.45;
export const DEFAULT_MIN_SCENE_DURATION_SEC = 2.0;

function toScene(start: number, end: number): Scene {
  return { start, end, duration: end - start };
}

/**
 * Detecta as cenas do vídeo diretamente a partir da narração.
 * Identifica as pausas reais do locutor, consolidando micro-pausas internas
 * e gerando trechos contíguos perfeitos onde a imagem troca no início de cada nova fala.
 */
export function detectScenesFromAudio(
  buffer: AudioBuffer | null,
  options: DetectScenesOptions = {},
): DetectedNarrationScene[] {
  if (!buffer || buffer.duration <= 0) return [];
  const duration = buffer.duration;
  const {
    minPauseSec = DEFAULT_SCENE_MIN_PAUSE_SEC,
    minSceneDurationSec = DEFAULT_MIN_SCENE_DURATION_SEC,
    maxSceneDurationSec = 25.0,
    sensitivity = 0.12,
    minSilenceSec = 0.35,
    windowMs,
    minSpeechSec,
    padSec,
  } = options;

  // Analisa o áudio usando VAD
  const analysis = analyzeAudioSpeech(buffer, {
    ...(windowMs === undefined ? {} : { windowMs }),
    ...(minSpeechSec === undefined ? {} : { minSpeechSec }),
    ...(padSec === undefined ? {} : { padSec }),
    minSilenceSec: Math.min(minSilenceSec, minPauseSec),
    sensitivity,
  });
  const { segments } = analysis;

  if (!segments.length) {
    return [
      {
        index: 0,
        start: 0,
        end: Number(duration.toFixed(2)),
        duration: Number(duration.toFixed(2)),
        speechStart: 0,
        speechEnd: Number(duration.toFixed(2)),
        pauseAfter: 0,
      },
    ];
  }

  // Agrupa segmentos de fala em cenas reais
  const sceneCuts: number[] = [0];
  const speechBounds: Array<{ start: number; end: number; pauseAfter: number }> = [];

  let currentSceneStart = 0;
  let currentSpeechStart = segments[0]!.start;
  let currentSpeechEnd = segments[0]!.end;

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!;
    const curr = segments[i]!;
    const pause = curr.start - prev.end;
    const currentSceneDuration = prev.end - currentSceneStart;

    // Quebra se a pausa atingir o limiar configurado E a cena atual já tiver duração saudável.
    // Quando o usuário escolhe um limiar mais conservador, uma cena longa também pode usar
    // uma pausa ligeiramente menor, mas nunca abaixo de 0.65s.
    const isNaturalBreak = pause >= minPauseSec && currentSceneDuration >= minSceneDurationSec;
    const isOverflowBreak =
      currentSceneDuration >= maxSceneDurationSec && pause >= Math.max(0.65, minPauseSec * 0.85);

    if (isNaturalBreak || isOverflowBreak) {
      speechBounds.push({
        start: currentSpeechStart,
        end: prev.end,
        pauseAfter: pause,
      });

      // Ponto de corte limpo: no meio da pausa de silêncio entre as falas,
      // evitando pegar o final da palavra anterior ou cortar o início da próxima
      const cutPoint = Number(
        Math.min(curr.start - 0.05, Math.max(prev.end + 0.05, (prev.end + curr.start) / 2)).toFixed(
          2,
        ),
      );
      sceneCuts.push(cutPoint);
      currentSceneStart = cutPoint;
      currentSpeechStart = curr.start;
    }
    currentSpeechEnd = curr.end;
  }
  speechBounds.push({
    start: currentSpeechStart,
    end: currentSpeechEnd,
    pauseAfter: Math.max(0, duration - currentSpeechEnd),
  });

  const detected: DetectedNarrationScene[] = [];
  for (let i = 0; i < sceneCuts.length; i++) {
    const start = sceneCuts[i]!;
    const end = i === sceneCuts.length - 1 ? duration : sceneCuts[i + 1]!;
    const bounds = speechBounds[i] ?? {
      start,
      end,
      pauseAfter: 0,
    };
    const roundedStart = Number(start.toFixed(2));
    const roundedEnd = Number(end.toFixed(2));
    detected.push({
      index: i,
      start: roundedStart,
      end: roundedEnd,
      duration: Number(Math.max(0.01, roundedEnd - roundedStart).toFixed(2)),
      speechStart: Number(bounds.start.toFixed(2)),
      speechEnd: Number(bounds.end.toFixed(2)),
      pauseAfter: Number(bounds.pauseAfter.toFixed(2)),
    });
  }

  return detected;
}

/**
 * - "audio": trechos baseados estritamente na detecção de pausas da narração.
 * - "paragraphs": cada parágrafo do roteiro corresponde a uma mídia.
 * - "balanced": os blocos de fala são agrupados por mídia.
 * - "even": fallback com divisão igual do tempo.
 */
export type SceneMode = "audio" | "paragraphs" | "balanced" | "even";

export interface SceneTimeline {
  scenes: Scene[];
  mode: SceneMode;
}

function evenScenes(count: number, duration: number): Scene[] {
  const size = duration / count;
  return Array.from({ length: count }, (_, i) =>
    toScene(i * size, i === count - 1 ? duration : (i + 1) * size),
  );
}

/** Quebra o roteiro em parágrafos (cada quebra de linha inicia um novo parágrafo). */
export function splitParagraphs(script: string): string[] {
  return script
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Descobre a qual parágrafo do roteiro cada bloco de legenda pertence.
 */
export function assignCaptionParagraphs(
  script: string,
  captionTexts: string[],
): { groups: number[]; paragraphCount: number } {
  const paragraphs = splitParagraphs(script);
  const paragraphStarts: number[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    paragraphStarts.push(cursor);
    cursor += paragraph.length + 1;
  }

  const groups: number[] = [];
  let captionCursor = 0;
  let paragraphIndex = 0;
  for (const text of captionTexts) {
    while (
      paragraphIndex + 1 < paragraphStarts.length &&
      paragraphStarts[paragraphIndex + 1]! <= captionCursor
    ) {
      paragraphIndex += 1;
    }
    groups.push(paragraphIndex);
    captionCursor += text.length + 1;
  }
  return { groups, paragraphCount: paragraphs.length };
}

/**
 * Escolhe qual bloco de fala inicia cada cena quando não há 1:1.
 */
function pickBalancedFirstCaptions(
  captions: Caption[],
  sceneCount: number,
  duration: number,
): number[] {
  const firsts: number[] = [0];
  for (let scene = 1; scene < sceneCount; scene += 1) {
    const target = (scene * duration) / sceneCount;
    const minIndex = (firsts[scene - 1] ?? 0) + 1;
    const maxIndex = captions.length - (sceneCount - scene);
    let best = minIndex;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = minIndex; index <= maxIndex; index += 1) {
      const distance = Math.abs((captions[index]?.start ?? 0) - target);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    firsts.push(best);
  }
  return firsts;
}

/**
 * Calcula o intervalo de cada cena para um conjunto de mídias e narração.
 * Se houver cenas detectadas no áudio, utiliza-as como referência prioritária.
 */
export function buildScenes(
  captions: Caption[],
  sceneCount: number,
  duration: number,
  captionGroups?: number[] | null,
  detectedAudioScenes?: DetectedNarrationScene[] | null,
): SceneTimeline {
  if (sceneCount <= 0 || !Number.isFinite(duration) || duration <= 0) {
    return { scenes: [], mode: "even" };
  }
  if (sceneCount === 1) {
    return { scenes: [toScene(0, duration)], mode: "even" };
  }

  // Se o número de mídias corresponder exatamente às cenas detectadas no áudio
  if (detectedAudioScenes && detectedAudioScenes.length === sceneCount) {
    return {
      scenes: detectedAudioScenes.map((s) => ({
        start: s.start,
        end: s.end,
        duration: s.duration,
        speechStart: s.speechStart,
        speechEnd: s.speechEnd,
        pauseAfter: s.pauseAfter,
      })),
      mode: "audio",
    };
  }

  if (captions.length < sceneCount) {
    return { scenes: evenScenes(sceneCount, duration), mode: "even" };
  }

  let firsts: number[] | null = null;
  let mode: SceneMode = "balanced";
  if (captionGroups && captionGroups.length === captions.length) {
    const byParagraph: number[] = [];
    for (let scene = 0; scene < sceneCount; scene += 1) {
      const index = captionGroups.indexOf(scene);
      if (index < 0) break;
      byParagraph.push(index);
    }
    if (byParagraph.length === sceneCount) {
      firsts = byParagraph;
      mode = "paragraphs";
    }
  }
  if (!firsts) firsts = pickBalancedFirstCaptions(captions, sceneCount, duration);

  const starts: number[] = [0];
  for (let scene = 1; scene < sceneCount; scene += 1) {
    const raw = captions[firsts[scene]!]?.start ?? 0;
    const previous = starts[scene - 1]!;
    const latest = duration - MIN_SCENE_SECONDS * (sceneCount - scene);
    starts.push(Math.min(latest, Math.max(previous + MIN_SCENE_SECONDS, raw)));
  }
  if (starts.some((start, i) => i > 0 && start <= starts[i - 1]!)) {
    return { scenes: evenScenes(sceneCount, duration), mode: "even" };
  }

  const scenes = starts.map((start, i) =>
    toScene(start, i === sceneCount - 1 ? duration : starts[i + 1]!),
  );
  return { scenes, mode };
}

/** Índice da cena exibida no instante `time` (busca binária). */
export function sceneIndexAt(scenes: Array<{ start: number; end: number }>, time: number): number {
  if (!scenes.length) return 0;
  let low = 0;
  let high = scenes.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (time >= scenes[mid]!.start) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Quebra o roteiro em frases completas respeitando a pontuação final (. ! ? …). */
export function splitFullSentences(script: string): string[] {
  return script
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?…])\s+|\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reconcilia um texto picado de legendas com as frases completas originais do roteiro,
 * garantindo que nenhuma cena comece com letras minúsculas ou fragmentos de frases anteriores.
 */
export function alignTextToFullSentences(rawText: string, script?: string): string {
  if (!script || !script.trim() || !rawText.trim()) return rawText.trim();
  const sentences = splitFullSentences(script);
  if (!sentences.length) return rawText.trim();

  const matchedSentences: string[] = [];
  const normalizedRaw = rawText.toLowerCase().replace(/\s+/g, " ");

  for (const sentence of sentences) {
    const normalizedSentence = sentence.toLowerCase().replace(/\s+/g, " ");

    // Se a frase inteira estiver contida no texto capturado
    if (normalizedRaw.includes(normalizedSentence)) {
      matchedSentences.push(sentence);
      continue;
    }

    // Se houver uma sobreposição expressiva
    const words = normalizedSentence.split(/\s+/).filter(Boolean);
    if (words.length >= 3) {
      const firstFew = words.slice(0, Math.min(4, words.length)).join(" ");
      const lastFew = words.slice(-Math.min(4, words.length)).join(" ");

      const containsStart = normalizedRaw.includes(firstFew);
      const containsEnd = normalizedRaw.includes(lastFew);

      // Se contém o início da frase, a frase começou nesta cena -> inclui
      if (containsStart) {
        matchedSentences.push(sentence);
      }
      // Se só contém o final da frase (sem o início), é rebarba da cena anterior -> não inclui
    }
  }

  if (matchedSentences.length > 0) {
    return matchedSentences.join(" ").trim();
  }

  return rawText.trim();
}

/**
 * Retorna o texto já alinhado ao intervalo de uma cena.
 * O ponto médio garante que cada legenda pertença a um único trecho, sem
 * expandir frases para além dos limites reproduzidos no preview.
 */
export function getSceneScriptText(
  captions: Caption[],
  sceneStart: number,
  sceneEnd: number,
  script?: string,
  sceneIndex?: number,
  totalScenes?: number,
): string {
  // 1. Procura legendas cujo ponto médio esteja contido no intervalo da cena
  if (captions && captions.length > 0) {
    const midpointCaptions = captions.filter((c) => {
      const mid = (c.start + c.end) / 2;
      return mid >= sceneStart && mid < sceneEnd;
    });

    if (midpointCaptions.length > 0) {
      return midpointCaptions
        .map((c) => c.text)
        .join(" ")
        .trim();
    }

    // Fallback: legendas com sobreposição temporal com a cena
    // Em uma grade de cenas, usar sobreposição repetia o mesmo bloco nos dois
    // lados da fronteira. O ponto médio acima fornece uma atribuição única.
    if (sceneIndex === undefined || totalScenes === undefined) {
      const overlapping = captions.filter((c) => c.start < sceneEnd && c.end > sceneStart);
      if (overlapping.length > 0) {
        return overlapping
          .map((c) => c.text)
          .join(" ")
          .trim();
      }
    }
  }

  // 2. Se o roteiro foi estruturado em parágrafos e coincide com o número de cenas
  if (script && script.trim() && sceneIndex !== undefined && totalScenes && totalScenes > 0) {
    const paragraphs = splitParagraphs(script);
    if (paragraphs.length === totalScenes && paragraphs[sceneIndex]) {
      return paragraphs[sceneIndex]!;
    }
  }

  return "";
}
