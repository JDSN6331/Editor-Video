import type { Caption, MotionEffect } from "./types";
import { sceneIndexAt, videoSourceTime } from "./scenes";

/** Desenha a imagem cobrindo todo o quadro (crop central) com zoom opcional. */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLVideoElement,
  w: number,
  h: number,
  zoom = 1,
  alpha = 1,
  horizontalPosition = 0.5,
  verticalPosition = 0.5,
): boolean {
  const isVideo = img instanceof HTMLVideoElement;
  const imageWidth = isVideo ? img.videoWidth : img.naturalWidth || img.width;
  const imageHeight = isVideo ? img.videoHeight : img.naturalHeight || img.height;
  if (
    (!isVideo && !img.complete) ||
    (isVideo && img.readyState < HTMLMediaElement.HAVE_METADATA) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0
  ) {
    return false;
  }

  const ratio = Math.max(w / imageWidth, h / imageHeight) * zoom;
  const dw = imageWidth * ratio;
  const dh = imageHeight * ratio;
  if (![ratio, dw, dh, alpha].every(Number.isFinite)) return false;

  ctx.save();
  try {
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    const safePosition = Math.max(0, Math.min(1, horizontalPosition));
    const safeVerticalPosition = Math.max(0, Math.min(1, verticalPosition));
    ctx.drawImage(img, (w - dw) * safePosition, (h - dh) * safeVerticalPosition, dw, dh);
    return true;
  } catch (error) {
    console.warn("Nao foi possivel desenhar uma imagem no preview.", error);
    return false;
  } finally {
    ctx.restore();
  }
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
  ctx.fillStyle = "rgba(72,72,72,0.7)";
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
    ctx.fillStyle = "#ffffff";
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
  images: Array<HTMLImageElement | HTMLVideoElement>,
  t: number,
  duration: number,
  w: number,
  h: number,
  captions: Caption[] | null,
  options: {
    kenBurns: boolean;
    fade: number;
    motionEffect?: MotionEffect | undefined;
    /** Intervalo exato de cada mídia; sem isso o tempo é dividido igualmente. */
    scenes?: Array<{ start: number; end: number }>;
    /** Início do corte de cada mídia de vídeo (mesma ordem de `images`). */
    trimStarts?: Array<number | undefined>;
  } = {
    kenBurns: true,
    fade: 0.6,
  },
) {
  if (!images.length || !Number.isFinite(duration) || duration <= 0) return;
  const safeTime = Math.max(0, Math.min(Number.isFinite(t) ? t : 0, duration));
  const scenes = options.scenes?.length ? options.scenes : null;
  const evenSize = duration / Math.max(1, images.length);
  const index = scenes
    ? sceneIndexAt(scenes, safeTime)
    : Math.max(0, Math.min(images.length - 1, Math.floor(safeTime / evenSize)));
  const sceneStart = scenes ? scenes[index]!.start : index * evenSize;
  const sceneEnd = scenes ? scenes[index]!.end : sceneStart + evenSize;
  const perImage = Math.max(0.001, sceneEnd - sceneStart);
  const local = Math.max(0, safeTime - sceneStart);
  const progress = Math.min(1, local / perImage);

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  // Falha de forma segura caso uma grade externa traga uma lacuna. A busca por
  // índice usa o início da cena; sem esta verificação, a mídia anterior poderia
  // continuar visível até o próximo início mesmo depois do próprio fim.
  const isLastFrame = index === images.length - 1 && Math.abs(safeTime - duration) < 0.001;
  if (safeTime < sceneStart || (safeTime >= sceneEnd && !isLastFrame)) return;

  const easedProgress = progress * progress * (3 - 2 * progress);
  const effect = options.motionEffect ?? (options.kenBurns ? "ken-burns" : "dissolve");
  const zoom =
    effect === "ken-burns"
      ? 1.05 + 0.1 * easedProgress
      : effect === "zoom"
        ? 1 + 0.12 * easedProgress
        : effect === "zoom-out"
          ? 1.12 - 0.12 * easedProgress
          : effect === "pan"
            ? 1.25
            : 1;
  const horizontalPosition =
    effect === "ken-burns" ? 0.2 + 0.6 * easedProgress : effect === "pan" ? progress : 0.5;
  const verticalPosition = effect === "ken-burns" ? 0.3 + 0.4 * easedProgress : 0.5;
  const current = images[index];
  // Vídeos precisam estar no quadro correto antes de serem desenhados. Se o seek
  // ainda não completou, o canvas fica em preto (já preenchido acima) em vez de
  // exibir o quadro da cena anterior — esse era o vazamento visual.
  let mediaReady = true;
  if (current instanceof HTMLVideoElement && Number.isFinite(current.duration)) {
    const target = videoSourceTime(
      current.duration,
      options.trimStarts?.[index] ?? 0,
      local,
      perImage,
    );
    // Tolerância apertada: ~1 quadro a 30 fps. O threshold anterior (120ms ≈ 3–4
    // frames) permitia desvios grandes demais; agora o seek é disparado com muito
    // mais frequência e o frame exibido é sempre o correto.
    const frameThreshold = 0.04;
    const drift = Math.abs(current.currentTime - target);
    if (drift > frameThreshold) {
      current.currentTime = target;
      // O seek é assíncrono: o quadro exibido ainda é o antigo. Marcar como "não
      // pronto" impede que o canvas desenhe o frame da cena anterior na transição.
      mediaReady = false;
    } else if (current.seeking || current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      // O navegador ainda está decodificando o quadro ou posicionando; desenhar
      // agora mostraria um frame obsoleto.
      mediaReady = false;
    }
  }
  if (current && mediaReady) {
    drawCover(ctx, current, w, h, zoom, 1, horizontalPosition, verticalPosition);
  }

  // O fade passa pelo preto dentro do próprio intervalo. Uma mídia nunca aparece
  // antes do início da cena dela, inclusive no preview.
  const fade = effect === "dissolve" ? Math.min(options.fade, perImage / 2) : 0;
  if (current && fade > 0) {
    const alpha =
      local < fade ? 1 - local / fade : perImage - local < fade ? 1 - (perImage - local) / fade : 0;
    if (alpha > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  if (captions) {
    const caption = captionAt(captions, safeTime);
    if (caption) {
      const captionDuration = Math.max(0.001, caption.end - caption.start);
      drawCaption(ctx, caption.text, w, h, {
        progress: (safeTime - caption.start) / captionDuration,
      });
    }
  }
}
