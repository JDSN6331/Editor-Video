export interface Caption {
  start: number;
  end: number;
  text: string;
}

export interface SourceImage {
  id: string;
  name: string;
  url: string;
  dataUrl?: string;
  blob?: Blob;
  element: HTMLImageElement;
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

export type MotionEffect = "ken-burns" | "zoom" | "pan" | "dissolve" | "zoom-out";
