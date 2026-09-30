import type { Caption } from "./types";

/** Desenha a imagem cobrindo todo o quadro (crop central) com zoom opcional. */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  zoom = 1,
  alpha = 1,
) {
  const ratio = Math.max(w / img.width, h / img.height) * zoom;
  const dw = img.width * ratio;
  const dh = img.height * ratio;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function drawCaption(
  ctx: CanvasRenderingContext2D,
  text: string,
  w: number,
  h: number,
  opts: { fontScale?: number; bottom?: number; progress?: number; accent?: string } = {},
) {
  const fontSize = Math.round(h * 0.05 * (opts.fontScale ?? 1));
  ctx.save();
  ctx.font = `700 ${fontSize}px Inter, "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const maxWidth = w * 0.82;
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize * 1.28;
  const blockHeight = lines.length * lineHeight;
  const bottomPad = h * (opts.bottom ?? 0.09);
  const startY = h - bottomPad - blockHeight + lineHeight / 2;

  const boxTop = startY - lineHeight / 2 - fontSize * 0.35;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const boxWidth = Math.min(maxWidth + fontSize, w * 0.94);
  roundRect(
    ctx,
    (w - boxWidth) / 2,
    boxTop,
    boxWidth,
    blockHeight + fontSize * 0.7,
    fontSize * 0.3,
  );
  ctx.fill();

  const captionProgress = Math.max(0, Math.min(1, opts.progress ?? 0));
  const completedCharacters = Math.floor(text.length * captionProgress);
  let characterOffset = 0;

  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    const x = (w - ctx.measureText(line).width) / 2;
    ctx.lineWidth = fontSize * 0.14;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(line, x, y);
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.fillText(line, x, y);

    const completedInLine = Math.max(
      0,
      Math.min(line.length, completedCharacters - characterOffset),
    );
    if (completedInLine > 0) {
      const highlighted = line.slice(0, completedInLine);
      ctx.strokeText(highlighted, x, y);
      ctx.fillStyle = opts.accent ?? "#ffd23f";
      ctx.fillText(highlighted, x, y);
    }
    characterOffset += line.length + 1;
  });
  ctx.restore();
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function captionAt(captions: Caption[], t: number): Caption | null {
  return captions.find((c) => t >= c.start && t < c.end) ?? null;
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  images: HTMLImageElement[],
  t: number,
  duration: number,
  w: number,
  h: number,
  captions: Caption[] | null,
  options: { kenBurns: boolean; fade: number } = { kenBurns: true, fade: 0.6 },
) {
  const perImage = duration / Math.max(1, images.length);
  const index = Math.min(images.length - 1, Math.floor(t / perImage));
  const local = t - index * perImage;
  const progress = perImage > 0 ? local / perImage : 0;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const zoom = options.kenBurns ? 1 + 0.06 * progress : 1;
  drawCover(ctx, images[index]!, w, h, zoom, 1);

  const fade = options.fade;
  const next = images[index + 1];
  if (next && fade > 0 && perImage - local < fade) {
    const alpha = 1 - (perImage - local) / fade;
    drawCover(ctx, next, w, h, 1, alpha);
  }

  if (captions) {
    const caption = captionAt(captions, t);
    if (caption) {
      const captionDuration = Math.max(0.001, caption.end - caption.start);
      drawCaption(ctx, caption.text, w, h, {
        progress: (t - caption.start) / captionDuration,
      });
    }
  }
}
