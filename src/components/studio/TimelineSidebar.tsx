import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Eye,
  Sliders,
  Sparkles,
  Scissors,
  Merge,
  SkipBack,
  SkipForward,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { cutsFromScenes, moveCut, sceneIndexAt, snapTime } from "@/lib/video/scenes";
import { VIDEO_PRESETS } from "@/lib/video/types";
import { isFilledMedia } from "@/lib/video/types";
import { drawFrame } from "@/lib/video/draw";
import { computeWaveformPeaks } from "@/lib/video/waveform";
import { Button } from "@/components/ui/button";

/* ───────────────────── Constantes ───────────────────── */

/** Pixels de tolerância para considerar o mouse "sobre" a borda de uma cena. */
const BORDER_HIT_PX = 6;
/** Tolerância de snap ao ponto de pausa automática mais próximo. */
const SNAP_THRESHOLD_SEC = 0.25;
/** Bins do waveform (resolução horizontal do desenho de áudio). */
const WAVEFORM_BINS = 600;

/* ─────────────────── Componentes auxiliares ─────────────────── */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium font-mono">{value}</dd>
    </div>
  );
}

/** Barra de forma de onda desenhada em um <canvas> leve. */
function WaveformBar({
  peaks,
  height,
  color,
}: {
  peaks: Float32Array;
  height: number;
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks.length) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    const barWidth = canvas.width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const barHeight = Math.max(1, peaks[i]! * canvas.height * 0.9);
      ctx.fillRect(
        i * barWidth,
        (canvas.height - barHeight) / 2,
        Math.max(1, barWidth - 0.5),
        barHeight,
      );
    }
  }, [peaks, height, color]);

  return <canvas ref={ref} style={{ height }} className="w-full block rounded" />;
}

/* ──────────────────── Componente principal ──────────────────── */

export function TimelineSidebar() {
  const {
    duration,
    images,
    perImage,
    scenes,
    detectedScenes,
    minSceneDuration,
    music,
    effectiveMusicVolume,
    captions,
    showCaptions,
    preset,
    fps,
    kenBurns,
    motionEffect,
    previewTime,
    setPreviewTime,
    previewPlaying: isPlayingPreview,
    setPreviewPlaying: setIsPlayingPreview,
    narration,
    narrationVolume,
    stopNarrationPreview,
    // Edição de cenas
    autoSceneCuts,
    isCustomizedScenes,
    commitSceneCuts,
    splitSceneAt,
    mergeSceneWithNext,
    resetSceneCuts,
    setMediaTrim,
  } = useVideoProject();

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewTimeRef = useRef(previewTime);
  previewTimeRef.current = previewTime;
  const [showFramePreview, setShowFramePreview] = useState(true);
  const [timelineZoom, setTimelineZoom] = useState(1);

  /* ── Waveform ── */
  const waveformPeaks = useMemo(
    () =>
      narration?.buffer
        ? computeWaveformPeaks(narration.buffer, WAVEFORM_BINS)
        : new Float32Array(0),
    [narration?.buffer],
  );

  /* ── Informações da cena atual ── */
  const previewSceneIndex = scenes.length
    ? sceneIndexAt(scenes, previewTime)
    : Math.max(0, Math.min(images.length - 1, Math.floor(previewTime / Math.max(0.001, perImage))));
  const previewSceneStart = scenes[previewSceneIndex]?.start ?? previewSceneIndex * perImage;
  const previewSceneEnd =
    scenes[previewSceneIndex]?.end ?? Math.min(duration, previewSceneStart + perImage);
  const previewSceneDuration = Math.max(0, previewSceneEnd - previewSceneStart);
  const previewSceneElapsed = Math.max(
    0,
    Math.min(previewSceneDuration, previewTime - previewSceneStart),
  );
  const currentMedia = isFilledMedia(images[previewSceneIndex])
    ? images[previewSceneIndex]
    : undefined;
  const filledMediaCount = images.filter(isFilledMedia).length;
  const currentVideoDuration =
    currentMedia?.kind === "video" && Number.isFinite(currentMedia.duration)
      ? Math.max(0, currentMedia.duration ?? 0)
      : 0;
  const maxTrimStart = Math.max(0, currentVideoDuration - previewSceneDuration);
  const currentTrimStart = Math.min(maxTrimStart, Math.max(0, currentMedia?.trimStart ?? 0));
  const currentTrimEnd = Math.min(currentVideoDuration, currentTrimStart + previewSceneDuration);

  /* ── Arrastar bordas de cena (drag) ── */
  const timelineRef = useRef<HTMLDivElement>(null);
  const [draggingBorder, setDraggingBorder] = useState<number | null>(null);
  const [hoverBorder, setHoverBorder] = useState<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const sceneCuts = useMemo(() => cutsFromScenes(detectedScenes), [detectedScenes]);
  const timelineBaseWidth = useMemo(
    () => Math.max(760, duration * 1.5, Math.max(scenes.length, images.length) * 52),
    [duration, scenes.length, images.length],
  );
  const timelineTicks = useMemo(() => {
    if (duration <= 0) return [];
    const step = duration <= 120 ? 10 : duration <= 300 ? 30 : 60;
    const ticks: number[] = [];
    for (let time = 0; time < duration; time += step) ticks.push(time);
    ticks.push(duration);
    return ticks;
  }, [duration]);

  /** Converte posição X do mouse para tempo (s). */
  const xToTime = useCallback(
    (clientX: number) => {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect || !duration) return 0;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  /** Verifica se o mouse está sobre uma borda e retorna o índice do corte. */
  const borderAtX = useCallback(
    (clientX: number): number | null => {
      const rect = timelineRef.current?.getBoundingClientRect();
      if (!rect || !duration || !sceneCuts.length) return null;
      const pxPerSec = rect.width / duration;
      for (let i = 0; i < sceneCuts.length; i++) {
        const borderPx = sceneCuts[i]! * pxPerSec;
        const mousePx = clientX - rect.left;
        if (Math.abs(mousePx - borderPx) <= BORDER_HIT_PX) return i;
      }
      return null;
    },
    [duration, sceneCuts],
  );

  const handleTimelineMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!duration) return;
      const border = borderAtX(e.clientX);
      if (border !== null) {
        e.preventDefault();
        setDraggingBorder(border);
        return;
      }
      // Clique normal → navega no tempo
      e.preventDefault();
      setIsScrubbing(true);
      setPreviewTime(xToTime(e.clientX));
    },
    [duration, borderAtX, xToTime, setPreviewTime],
  );

  // Drag global (mouse move + mouse up)
  useEffect(() => {
    if (draggingBorder === null) return;
    const onMove = (e: MouseEvent) => {
      let time = xToTime(e.clientX);
      // Snap magnético ao ponto de pausa automática mais próximo
      time = snapTime(time, autoSceneCuts, SNAP_THRESHOLD_SEC);
      const updated = moveCut(sceneCuts, draggingBorder, time, duration);
      commitSceneCuts(updated);
    };
    const onUp = () => setDraggingBorder(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draggingBorder, sceneCuts, duration, xToTime, autoSceneCuts, commitSceneCuts]);

  // Arrastar em qualquer área livre move a agulha continuamente (scrubbing).
  useEffect(() => {
    if (!isScrubbing) return;
    const onMove = (event: MouseEvent) => setPreviewTime(xToTime(event.clientX));
    const onUp = () => setIsScrubbing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isScrubbing, setPreviewTime, xToTime]);

  // Cursor de resize ao passar sobre as bordas
  const handleTimelineMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (draggingBorder !== null) return;
      setHoverBorder(borderAtX(e.clientX));
    },
    [borderAtX, draggingBorder],
  );

  const handleTimelineMouseLeave = useCallback(() => {
    if (draggingBorder === null) setHoverBorder(null);
  }, [draggingBorder]);

  /* ── Preview no canvas ── */
  useEffect(() => {
    if (!duration || !images.length || !previewCanvasRef.current) return;
    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const htmlImages = images.map((i) => i.element);
    try {
      drawFrame(
        ctx,
        htmlImages,
        previewTime,
        duration,
        canvas.width,
        canvas.height,
        showCaptions ? captions : null,
        {
          kenBurns,
          fade: Math.min(0.6, minSceneDuration / 4),
          motionEffect,
          scenes,
          trimStarts: images.map((i) => i.trimStart),
        },
      );
    } catch (error) {
      // Preview é apenas uma conveniência visual e nunca deve derrubar o editor.
      console.warn("Falha ao atualizar o preview da linha do tempo.", error);
      setIsPlayingPreview(false);
    }
  }, [
    previewTime,
    duration,
    images,
    captions,
    showCaptions,
    kenBurns,
    motionEffect,
    minSceneDuration,
    scenes,
    showFramePreview,
    setIsPlayingPreview,
  ]);

  /* ── Reprodução em tempo real ── */
  useEffect(() => {
    if (!isPlayingPreview || duration <= 0) return;
    let animId = 0;
    let cancelled = false;
    stopNarrationPreview();

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    let audioCtx: AudioContext | null = null;
    let gain: GainNode | null = null;
    try {
      if (narration?.buffer && AudioContextCtor) {
        audioCtx = new AudioContextCtor();
        gain = audioCtx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, narrationVolume / 100));
        gain.connect(audioCtx.destination);
        void audioCtx.resume();
      }
    } catch {
      audioCtx = null;
    }

    let source: AudioBufferSourceNode | null = null;
    let base = 0;
    let audioStartAt = 0;
    let wallStart = 0;
    const stopSource = () => {
      if (!source) return;
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* já terminou */
      }
      source.disconnect();
      source = null;
    };
    const begin = (from: number) => {
      stopSource();
      base = from;
      wallStart = performance.now();
      if (audioCtx && gain && narration?.buffer) {
        source = audioCtx.createBufferSource();
        source.buffer = narration.buffer;
        source.connect(gain);
        audioStartAt = audioCtx.currentTime + 0.02;
        source.start(audioStartAt, Math.min(from, narration.buffer.duration - 0.01));
      }
    };
    const clock = () =>
      audioCtx && source
        ? base + Math.max(0, audioCtx.currentTime - audioStartAt)
        : base + (performance.now() - wallStart) / 1000;

    const startFrom = previewTimeRef.current >= duration - 0.05 ? 0 : previewTimeRef.current;
    begin(startFrom);
    let lastSet = startFrom;

    const step = () => {
      if (cancelled) return;
      // O usuário arrastou o cursor durante a reprodução: ressincroniza áudio e imagem.
      if (Math.abs(previewTimeRef.current - lastSet) > 0.25) begin(previewTimeRef.current);
      const next = clock();
      if (next >= duration) {
        setPreviewTime(0);
        setIsPlayingPreview(false);
        return;
      }
      lastSet = next;
      setPreviewTime(next);
      animId = requestAnimationFrame(step);
    };
    animId = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      if (animId) cancelAnimationFrame(animId);
      stopSource();
      if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
    };
  }, [
    isPlayingPreview,
    duration,
    setPreviewTime,
    setIsPlayingPreview,
    narration?.buffer,
    narrationVolume,
    stopNarrationPreview,
  ]);

  /* ── Atalhos de teclado ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Não captura quando o foco está em um campo de texto
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Space") {
        e.preventDefault();
        setIsPlayingPreview((v) => !v);
      }
      if (e.code === "KeyS" && !e.ctrlKey && !e.metaKey && scenes.length > 0) {
        e.preventDefault();
        splitSceneAt(previewTimeRef.current);
      }
      if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const direction = e.code === "ArrowLeft" ? -1 : 1;
        const amount = e.shiftKey ? 1 : 1 / Math.max(1, fps);
        setPreviewTime((time) => Math.max(0, Math.min(duration, time + direction * amount)));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [duration, fps, scenes.length, setIsPlayingPreview, setPreviewTime, splitSceneAt]);

  /* ── Navegar entre cenas ── */
  const goToPrevScene = useCallback(() => {
    if (!scenes.length) return;
    const idx = sceneIndexAt(scenes, previewTime);
    const target = idx > 0 ? scenes[idx - 1]!.start : 0;
    setPreviewTime(target);
  }, [scenes, previewTime, setPreviewTime]);

  const goToNextScene = useCallback(() => {
    if (!scenes.length) return;
    const idx = sceneIndexAt(scenes, previewTime);
    const target = idx < scenes.length - 1 ? scenes[idx + 1]!.start : scenes[idx]!.start;
    setPreviewTime(target);
  }, [scenes, previewTime, setPreviewTime]);

  return (
    <div className="glass-panel rounded-2xl border p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-semibold flex items-center gap-2">
          <Sliders className="size-4 text-primary" />
          Linha do Tempo
        </h2>

        <div className="flex items-center gap-2">
          {duration > 0 && (
            <div className="flex items-center rounded-lg border border-border bg-background/50 p-0.5">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={timelineZoom <= 0.5}
                onClick={() => setTimelineZoom((zoom) => Math.max(0.5, zoom - 0.25))}
                title="Diminuir zoom da linha do tempo"
              >
                <ZoomOut className="size-3.5" />
              </Button>
              <button
                type="button"
                onClick={() => setTimelineZoom(1)}
                className="min-w-12 px-1 text-[10px] font-mono text-muted-foreground hover:text-foreground"
                title="Restaurar zoom para 100%"
              >
                {Math.round(timelineZoom * 100)}%
              </button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={timelineZoom >= 3}
                onClick={() => setTimelineZoom((zoom) => Math.min(3, zoom + 0.25))}
                title="Aumentar zoom da linha do tempo"
              >
                <ZoomIn className="size-3.5" />
              </Button>
            </div>
          )}
          {duration > 0 && filledMediaCount > 0 && (
            <button
              onClick={() => setShowFramePreview((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
            >
              <Eye className="size-3" />
              {showFramePreview ? "Ocultar Preview" : "Ver Preview"}
            </button>
          )}
        </div>
      </div>

      {duration > 0 && (images.length > 0 || scenes.length > 0) ? (
        <>
          {/* Preview de Frame */}
          {showFramePreview && images.length > 0 && (
            <div className="mt-3 max-w-xl overflow-hidden rounded-xl border border-border bg-black shadow-sm relative group">
              <canvas
                ref={previewCanvasRef}
                width={384}
                height={216}
                className="w-full aspect-video block"
              />
              <div
                className="absolute top-2 right-2 rounded bg-black/75 px-2 py-1 text-[10px] font-mono text-white/90 backdrop-blur"
                title={`Tempo decorrido na cena ${previewSceneIndex + 1} / duração da cena`}
              >
                <span className="mr-1.5 font-sans font-semibold text-white">
                  Cena {previewSceneIndex + 1}
                </span>
                {formatTime(previewSceneElapsed, true)} / {formatTime(previewSceneDuration, true)}
              </div>
            </div>
          )}

          {/* Controles de Reprodução */}
          <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-background/50 px-3 py-1.5">
            <div className="flex items-center gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={goToPrevScene}
                title="Cena anterior"
              >
                <SkipBack className="size-3 text-muted-foreground" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => setIsPlayingPreview((v) => !v)}
                title={isPlayingPreview ? "Pausar (Espaço)" : "Reproduzir (Espaço)"}
              >
                {isPlayingPreview ? (
                  <Pause className="size-3.5 text-primary" />
                ) : (
                  <Play className="size-3.5 text-primary" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => {
                  setIsPlayingPreview(false);
                  setPreviewTime(0);
                }}
                title="Voltar ao início"
              >
                <RotateCcw className="size-3 text-muted-foreground" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={goToNextScene}
                title="Próxima cena"
              >
                <SkipForward className="size-3 text-muted-foreground" />
              </Button>
            </div>

            <div className="text-xs font-mono">
              <span className="text-primary font-semibold">{formatTime(previewTime)}</span> /{" "}
              <span className="text-muted-foreground">{formatTime(duration)}</span>
            </div>
          </div>

          {/* ── Timeline Profissional ── */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>
              Arraste a agulha para navegar. Arraste os círculos entre cenas para editar os cortes.
            </span>
            <span className="font-mono">Rolagem horizontal disponível</span>
          </div>
          <div className="mt-2 overflow-x-auto rounded-xl border border-border/70 bg-background/35 p-2 pb-3">
            <div
              className="space-y-1"
              style={{ width: `max(100%, ${Math.round(timelineBaseWidth * timelineZoom)}px)` }}
            >
              {/* Régua de tempo */}
              <div className="relative h-6 border-b border-border/60 text-[9px] font-mono text-muted-foreground select-none">
                {timelineTicks.map((time) => (
                  <div
                    key={`tick-${time}`}
                    className="absolute inset-y-0 border-l border-border/70"
                    style={{ left: `${(time / duration) * 100}%` }}
                  >
                    <span className="absolute left-1 top-0 whitespace-nowrap">
                      {formatTime(time, true)}
                    </span>
                  </div>
                ))}
              </div>
              {/* Barra de cenas com bordas arrastáveis */}
              <div
                ref={timelineRef}
                onMouseDown={handleTimelineMouseDown}
                onMouseMove={handleTimelineMouseMove}
                onMouseLeave={handleTimelineMouseLeave}
                className="relative h-20 w-full overflow-visible rounded-lg border border-border select-none bg-background/80 group"
                style={{
                  cursor:
                    draggingBorder !== null
                      ? "col-resize"
                      : hoverBorder !== null
                        ? "col-resize"
                        : "pointer",
                }}
                title="Clique para navegar · Arraste as bordas para ajustar cenas"
              >
                {/* Faixas de Cenas */}
                <div className="flex h-full w-full">
                  {scenes.length > 0
                    ? scenes.map((scene, idx) => {
                        const slot = images[idx];
                        const img = isFilledMedia(slot) ? slot : undefined;
                        const sceneDuration = scene.duration;
                        const isActive = idx === previewSceneIndex;
                        return (
                          <div
                            key={img?.id ?? `scene-slot-${idx}`}
                            title={`Cena ${idx + 1} (${formatTime(scene.start)} – ${formatTime(scene.end)} · ${sceneDuration.toFixed(1)}s)${img ? `: ${img.name}` : " (sem mídia)"}`}
                            className={`border-r border-background/60 last:border-0 relative transition-all ${
                              img
                                ? "bg-cover bg-center"
                                : "bg-secondary/40 border-dashed flex items-center justify-center text-[9px] text-muted-foreground font-mono"
                            }`}
                            style={{
                              backgroundImage:
                                img?.kind === "video" && img.posterUrl
                                  ? `url(${img.posterUrl})`
                                  : img
                                    ? `url(${img.url})`
                                    : undefined,
                              flexGrow: Math.max(0.0001, sceneDuration),
                              flexBasis: 0,
                              opacity: isActive ? 1 : 0.75,
                              outline: isActive ? "2px solid var(--primary)" : "none",
                              outlineOffset: "-2px",
                              borderRadius: "4px",
                            }}
                          >
                            {/* Indicador de tipo (imagem/vídeo) e número */}
                            <span
                              className={`absolute bottom-1 left-1 rounded px-1.5 py-0.5 text-[9px] font-mono flex items-center gap-0.5 ${
                                img ? "bg-black/70 text-white" : "bg-background/80 text-foreground"
                              }`}
                            >
                              {img?.kind === "video" && <span className="text-[7px]">▶</span>}
                              {idx + 1}
                            </span>
                            <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1 text-[8px] font-mono text-white/85">
                              {sceneDuration.toFixed(1)}s
                            </span>
                            {/* Indicador de trim para vídeos */}
                            {img?.kind === "video" && (img.trimStart ?? 0) > 0.01 && (
                              <span className="absolute top-0.5 right-0.5 rounded bg-amber-500/80 px-1 text-[7px] font-mono text-white">
                                ✂ {(img.trimStart ?? 0).toFixed(1)}s
                              </span>
                            )}
                          </div>
                        );
                      })
                    : images.map((img, idx) => (
                        <div
                          key={img.id}
                          title={`#${idx + 1} ${img.name} (${perImage.toFixed(1)}s)`}
                          className="flex-1 border-r border-background/60 bg-cover bg-center last:border-0 relative opacity-90 group-hover:opacity-100 transition-opacity"
                          style={{
                            backgroundImage:
                              img.kind === "video" && img.posterUrl
                                ? `url(${img.posterUrl})`
                                : `url(${img.url})`,
                          }}
                        >
                          <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[9px] text-white font-mono">
                            {idx + 1}
                          </span>
                        </div>
                      ))}
                </div>

                {/* Bordas arrastáveis (handles visuais) */}
                {sceneCuts.map((cut, idx) => (
                  <div
                    key={`border-${idx}`}
                    className="absolute top-0 bottom-0 z-10"
                    style={{
                      left: `${(cut / duration) * 100}%`,
                      width: BORDER_HIT_PX * 2,
                      marginLeft: -BORDER_HIT_PX,
                      cursor: "col-resize",
                    }}
                  >
                    <div
                      className={`absolute inset-y-0 left-1/2 -ml-px w-0.5 transition-colors ${
                        draggingBorder === idx || hoverBorder === idx
                          ? "bg-primary shadow-[0_0_6px_rgba(255,122,41,0.7)]"
                          : "bg-white/30"
                      }`}
                    />
                    {/* Handle central */}
                    <div
                      className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-3 rounded-full border-2 transition-all ${
                        draggingBorder === idx || hoverBorder === idx
                          ? "border-primary bg-primary/30 scale-125"
                          : "border-white/50 bg-black/40 scale-100"
                      }`}
                    />
                  </div>
                ))}

                {/* Scrubber / Agulha de Reprodução */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-primary shadow-[0_0_8px_rgba(255,122,41,0.8)] pointer-events-none z-20"
                  style={{
                    left: `${(previewTime / duration) * 100}%`,
                  }}
                >
                  <div className="size-2.5 -ml-[4.5px] -mt-0.5 rounded-sm bg-primary rotate-45" />
                </div>
              </div>

              {/* Trilha de Narração com waveform */}
              <div
                className="flex h-9 items-center rounded bg-primary/15 px-2 overflow-hidden"
                title="Faixa da Narração"
              >
                <span className="text-[8px] uppercase tracking-wider text-primary font-bold mr-1 shrink-0">
                  Voz
                </span>
                {waveformPeaks.length > 0 ? (
                  <WaveformBar peaks={waveformPeaks} height={28} color="rgba(255,122,41,0.65)" />
                ) : (
                  <span className="h-1.5 flex-1 rounded-sm bg-primary/60" />
                )}
              </div>

              {/* Trilha de Música */}
              {music && (
                <div
                  className="flex h-6 items-center rounded bg-accent/20 px-2 overflow-hidden"
                  style={{ opacity: Math.max(0.3, effectiveMusicVolume) }}
                  title="Faixa de Trilha Sonora"
                >
                  <span className="text-[8px] uppercase tracking-wider text-accent font-bold mr-1">
                    BGM
                  </span>
                  <span className="h-1.5 flex-1 rounded-sm bg-accent/60" />
                </div>
              )}

              {/* Trilha de Legendas (miniatura) */}
              {captions.length > 0 && showCaptions && (
                <div
                  className="relative h-5 rounded bg-muted/30 overflow-hidden"
                  title="Faixa de Legendas"
                >
                  {captions.map((c, i) => (
                    <div
                      key={`cap-${i}`}
                      className="absolute top-1 bottom-1 rounded-sm bg-yellow-400/45"
                      style={{
                        left: `${(c.start / duration) * 100}%`,
                        width: `${Math.max(0.3, ((c.end - c.start) / duration) * 100)}%`,
                      }}
                    />
                  ))}
                  <span className="absolute left-1 top-0.5 text-[8px] text-muted-foreground font-bold uppercase">
                    CC
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Inspetor do clipe de vídeo ativo */}
          {currentMedia?.kind === "video" && currentVideoDuration > 0 && (
            <div className="mt-2 rounded-lg border border-border bg-background/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate font-medium text-foreground">
                  Recorte da Cena {previewSceneIndex + 1}: {currentMedia.name}
                </span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  fonte {formatTime(currentVideoDuration, true)}
                </span>
              </div>

              <input
                type="range"
                min={0}
                max={Math.max(0, maxTrimStart)}
                step={1 / Math.max(1, fps)}
                value={currentTrimStart}
                disabled={maxTrimStart <= 0}
                onChange={(event) =>
                  setMediaTrim(previewSceneIndex, Number(event.currentTarget.value))
                }
                className="mt-2 h-1.5 w-full cursor-ew-resize accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Ponto de entrada do vídeo na cena"
              />

              <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground">
                <span>Entrada {formatTime(currentTrimStart, true)}</span>
                <span>Saída {formatTime(currentTrimEnd, true)}</span>
                <span>Cena {formatTime(previewSceneDuration, true)}</span>
              </div>

              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                {currentVideoDuration > previewSceneDuration
                  ? `O trecho escolhido é limitado à cena. Os ${formatTime(
                      Math.max(0, currentVideoDuration - currentTrimEnd),
                      true,
                    )} restantes do vídeo não entram nesta cena.`
                  : currentVideoDuration < previewSceneDuration
                    ? "O vídeo é menor que a cena e será repetido somente dentro deste mesmo trecho."
                    : "O vídeo ocupa exatamente a duração da cena."}
              </p>
            </div>
          )}

          {/* ── Ferramentas de Edição ── */}
          {scenes.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-[11px] text-muted-foreground hover:text-primary"
                onClick={() => splitSceneAt(previewTime)}
                title="Dividir cena no cursor (S)"
              >
                <Scissors className="size-3" />
                Dividir
              </Button>
              {previewSceneIndex < scenes.length - 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-[11px] text-muted-foreground hover:text-primary"
                  onClick={() => mergeSceneWithNext(previewSceneIndex)}
                  title="Fundir cena atual com a próxima"
                >
                  <Merge className="size-3" />
                  Fundir
                </Button>
              )}
              {isCustomizedScenes && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-[11px] text-amber-500 hover:text-amber-400"
                  onClick={resetSceneCuts}
                  title="Desfazer ajustes manuais e voltar à detecção automática"
                >
                  <Undo2 className="size-3" />
                  Resetar cortes
                </Button>
              )}
            </div>
          )}

          {/* Atalhos de teclado */}
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground/60">
            <span>
              <kbd className="rounded border border-border bg-muted/50 px-1 py-0.5 font-mono text-[9px]">
                Espaço
              </kbd>{" "}
              Play/Pause
            </span>
            {scenes.length > 0 && (
              <span>
                <kbd className="rounded border border-border bg-muted/50 px-1 py-0.5 font-mono text-[9px]">
                  S
                </kbd>{" "}
                Dividir cena
              </span>
            )}
            <span>
              <kbd className="rounded border border-border bg-muted/50 px-1 py-0.5 font-mono text-[9px]">
                ← →
              </kbd>{" "}
              1 quadro
            </span>
            <span>
              <kbd className="rounded border border-border bg-muted/50 px-1 py-0.5 font-mono text-[9px]">
                Shift + ← →
              </kbd>{" "}
              1 segundo
            </span>
          </div>

          {/* Estatísticas */}
          <dl className="mt-3 grid gap-x-8 gap-y-2 border-t border-border pt-3 sm:grid-cols-2 xl:grid-cols-3">
            <Row label="Duração Total" value={formatTime(duration, true)} />
            <Row label="Cenas" value={`${scenes.length || images.length} cena(s)`} />
            <Row
              label="Mídias Encaixadas"
              value={`${filledMediaCount} de ${scenes.length || images.length}`}
            />
            <Row
              label="Tempo Médio / Cena"
              value={`${(duration / Math.max(1, scenes.length || images.length)).toFixed(2).replace(".", ",")} s`}
            />
            <Row label="Blocos de Legenda" value={`${captions.length}`} />
            <Row
              label="Resolução & FPS"
              value={`${VIDEO_PRESETS[preset].width}×${VIDEO_PRESETS[preset].height} @ ${fps}fps`}
            />
          </dl>
        </>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-border py-8 text-center text-muted-foreground text-xs space-y-1.5">
          <Sparkles className="size-5 mx-auto text-muted-foreground/50 mb-1" />
          <p className="font-medium text-foreground text-sm">Aguardando Mídias</p>
          <p>
            Carregue a narração e imagens para ativar a linha do tempo interativa e o preview em
            tempo real.
          </p>
        </div>
      )}
    </div>
  );
}
