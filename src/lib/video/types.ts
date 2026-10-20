export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface Caption {
  start: number;
  end: number;
  text: string;
  /** Tempos reconhecidos no áudio, usados no destaque palavra por palavra. */
  words?: CaptionWord[];
}

export interface SourceImage {
  id: string;
  name: string;
  url: string;
  dataUrl?: string;
  blob?: Blob;
  kind: "image" | "video";
  element: HTMLImageElement | HTMLVideoElement;
  duration?: number;
  posterUrl?: string;
  /**
   * Início do corte (em segundos) dentro de um vídeo. A cena exibe o trecho que
   * começa neste ponto; o que passar do fim da cena é cortado.
   */
  trimStart?: number;
  /** Slot reservado de uma cena cuja mídia foi removida sem deslocar as demais. */
  isPlaceholder?: boolean;
}

export function isFilledMedia(media: SourceImage | null | undefined): media is SourceImage {
  return Boolean(media && !media.isPlaceholder);
}

/** Preenche lacunas existentes antes de anexar novas mídias, sem deslocar cenas. */
export function fillEmptyMediaSlotsInOrder<T extends { isPlaceholder?: boolean }>(
  slots: readonly T[],
  media: readonly T[],
): T[] {
  const next = [...slots];
  let mediaIndex = 0;
  for (let slotIndex = 0; slotIndex < next.length && mediaIndex < media.length; slotIndex += 1) {
    if (next[slotIndex]?.isPlaceholder) {
      next[slotIndex] = media[mediaIndex]!;
      mediaIndex += 1;
    }
  }
  if (mediaIndex < media.length) next.push(...media.slice(mediaIndex));
  return next;
}

export interface AudioAsset {
  name: string;
  file: File;
  url: string;
  duration: number;
}

export const VIDEO_PRESETS = {
  "1080p": { width: 1920, height: 1080, label: "1080p (Full HD)" },
  "720p": { width: 1280, height: 720, label: "720p (HD)" },
} as const;

export type PresetKey = keyof typeof VIDEO_PRESETS;

export type MotionEffect = "none" | "ken-burns" | "zoom" | "pan" | "dissolve" | "zoom-out";
