import { drawCover, roundRect } from "./draw";

export interface ThumbnailOptions {
  image: HTMLImageElement | HTMLVideoElement;
  title: string;
  subtitle?: string;
  accent: string;
  width?: number;
  height?: number;
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
  const fontSize = title.length > 40 ? 64 : title.length > 22 ? 82 : 104;
  ctx.font = `800 ${fontSize}px Inter, "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const maxWidth = w * 0.86;
  const words = title.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else current = test;
  }
  if (current) lines.push(current);

  const lineHeight = fontSize * 1.1;
  const subtitle = opts.subtitle?.trim();
  const bottom = subtitle ? h - 110 : h - 64;
  const startY = bottom - (lines.length - 1) * lineHeight;

  // barra de destaque
  ctx.fillStyle = opts.accent;
  roundRect(ctx, 56, startY - fontSize, 12, lines.length * lineHeight, 6);
  ctx.fill();

  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    ctx.lineWidth = fontSize * 0.16;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.strokeText(line, 90, y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(line, 90, y);
  });

  if (subtitle) {
    ctx.font = `600 38px Inter, "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = opts.accent;
    ctx.fillText(subtitle.toUpperCase(), 90, h - 48);
  }
}
