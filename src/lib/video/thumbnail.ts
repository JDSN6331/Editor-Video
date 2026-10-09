import { drawCover, roundRect } from "./draw";

export interface ThumbnailOptions {
  image: HTMLImageElement | HTMLVideoElement;
  title: string;
  subtitle?: string;
  accent: string;
  width?: number;
  height?: number;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    let fragment = "";
    for (const character of word) {
      const candidate = `${fragment}${character}`;
      if (ctx.measureText(candidate).width > maxWidth && fragment) {
        lines.push(fragment);
        fragment = character;
      } else {
        fragment = candidate;
      }
    }
    current = fragment;
  }

  if (current) lines.push(current);
  return lines;
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  initialSize: number,
  minSize: number,
  maxWidth: number,
  maxLines: number,
) {
  let fontSize = initialSize;
  let lines: string[] = [];

  do {
    ctx.font = `${weight} ${fontSize}px Inter, "Segoe UI", system-ui, sans-serif`;
    lines = wrapText(ctx, text, maxWidth);
    if (lines.length <= maxLines) break;
    if (fontSize === minSize) break;
    fontSize = Math.max(minSize, fontSize - 2);
  } while (fontSize >= minSize);

  return { fontSize, lines };
}

/** Gera a thumbnail 1280x720 com legenda em destaque. */
export function drawThumbnail(canvas: HTMLCanvasElement, opts: ThumbnailOptions) {
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  drawCover(ctx, opts.image, w, h, 1.02, 1);

  const grad = ctx.createLinearGradient(0, h * 0.25, 0, h);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const title = opts.title.trim().toUpperCase();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const maxWidth = w * 0.86;
  const initialTitleSize = title.length > 40 ? 64 : title.length > 22 ? 82 : 104;
  const titleLayout = fitText(ctx, title, 800, initialTitleSize, 44, maxWidth, 3);
  const { fontSize, lines } = titleLayout;
  const lineHeight = fontSize * 1.1;
  const subtitle = opts.subtitle?.trim().toUpperCase();
  const subtitleLayout = subtitle ? fitText(ctx, subtitle, 600, 38, 26, maxWidth, 2) : null;
  const subtitleLineHeight = subtitleLayout ? subtitleLayout.fontSize * 1.15 : 0;
  const subtitleBottom = h - 48;
  const subtitleTop = subtitleLayout
    ? subtitleBottom - (subtitleLayout.lines.length - 1) * subtitleLineHeight
    : subtitleBottom;
  const titleSubtitleGap = 24;
  const bottom = subtitleLayout
    ? subtitleTop - subtitleLayout.fontSize - titleSubtitleGap
    : h - 64;
  const startY = bottom - (lines.length - 1) * lineHeight;

  // barra de destaque
  ctx.fillStyle = opts.accent;
  roundRect(ctx, 56, startY - fontSize, 12, lines.length * lineHeight, 6);
  ctx.fill();

  ctx.font = `800 ${fontSize}px Inter, "Segoe UI", system-ui, sans-serif`;
  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    ctx.lineWidth = fontSize * 0.16;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.strokeText(line, 90, y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(line, 90, y);
  });

  if (subtitleLayout) {
    ctx.font = `600 ${subtitleLayout.fontSize}px Inter, "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = opts.accent;
    subtitleLayout.lines.forEach((line, index) => {
      const y = subtitleTop + index * subtitleLineHeight;
      ctx.fillText(line, 90, y);
    });
  }
}
