import { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw, Eye, Sliders, Sparkles } from "lucide-react";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { VIDEO_PRESETS } from "@/lib/video/types";
import { drawFrame } from "@/lib/video/draw";
import { Button } from "@/components/ui/button";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium font-mono">{value}</dd>
    </div>
  );
}

export function TimelineSidebar() {
  const {
    duration,
    images,
    perImage,
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
  } = useVideoProject();

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const playbackStartedAtRef = useRef(0);
  const playbackOffsetRef = useRef(0);
  const previewTimeRef = useRef(previewTime);
  previewTimeRef.current = previewTime;
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [showFramePreview, setShowFramePreview] = useState(true);

  // Renderiza o frame no canvas de preview sempre que o previewTime mudar
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
        { kenBurns, fade: Math.min(0.6, perImage / 4), motionEffect },
      );
    } catch (error) {
      // Preview e apenas uma conveniencia visual e nunca deve derrubar o editor.
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
    perImage,
    showFramePreview,
  ]);

  // Reprodução em tempo real no preview
  useEffect(() => {
    let animId = 0;
    let cancelled = false;

    if (isPlayingPreview) {
      playbackStartedAtRef.current = performance.now();
      playbackOffsetRef.current = Math.min(previewTimeRef.current, duration);
      const step = (now: number) => {
        if (cancelled) return;
        const next = playbackOffsetRef.current + (now - playbackStartedAtRef.current) / 1000;
        if (next >= duration) {
          setPreviewTime(0);
          setIsPlayingPreview(false);
          return;
        }
        setPreviewTime(next);
        animId = requestAnimationFrame(step);
      };
      animId = requestAnimationFrame(step);
    }

    return () => {
      cancelled = true;
      if (animId) cancelAnimationFrame(animId);
    };
  }, [isPlayingPreview, duration, setPreviewTime]);

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setPreviewTime(ratio * duration);
  };

  return (
    <div className="glass-panel rounded-2xl border p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-semibold flex items-center gap-2">
          <Sliders className="size-4 text-primary" />
          Linha do Tempo
        </h2>

        {duration > 0 && images.length > 0 && (
          <button
            onClick={() => setShowFramePreview((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
          >
            <Eye className="size-3" />
            {showFramePreview ? "Ocultar Preview" : "Ver Preview"}
          </button>
        )}
      </div>

      {duration && images.length ? (
        <>
          {/* Preview de Frame Estático (Fase 1.4) */}
          {showFramePreview && (
            <div className="mt-3 overflow-hidden rounded-xl border border-border bg-black shadow-sm relative group">
              <canvas
                ref={previewCanvasRef}
                width={384}
                height={216}
                className="w-full aspect-video block"
              />
              <div className="absolute top-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-mono text-white/90 backdrop-blur">
                {formatTime(previewTime, true)}
              </div>
            </div>
          )}

          {/* Controles de Reprodução do Preview */}
          <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-background/50 px-3 py-1.5">
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => setIsPlayingPreview((v) => !v)}
                title={isPlayingPreview ? "Pausar" : "Reproduzir Preview"}
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
            </div>

            <div className="text-xs font-mono">
              <span className="text-primary font-semibold">{formatTime(previewTime)}</span> /{" "}
              <span className="text-muted-foreground">{formatTime(duration)}</span>
            </div>
          </div>

          {/* Timeline Interativa com Scrubbing (Fase 1.3) */}
          <div className="mt-3 space-y-1.5">
            <div
              onClick={handleTimelineClick}
              className="relative h-10 w-full overflow-hidden rounded-lg border border-border cursor-pointer select-none bg-background/80 group"
              title="Clique para navegar no tempo"
            >
              {/* Faixas de Imagens */}
              <div className="flex h-full w-full">
                {images.map((img, idx) => (
                  <div
                    key={img.id}
                    title={`#${idx + 1} ${img.name} (${perImage.toFixed(1)}s)`}
                    className="flex-1 border-r border-background/60 bg-cover bg-center last:border-0 relative opacity-90 group-hover:opacity-100 transition-opacity"
                    style={{ backgroundImage: `url(${img.url})` }}
                  >
                    <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[9px] text-white font-mono">
                      {idx + 1}
                    </span>
                  </div>
                ))}
              </div>

              {/* Scrubber / Agulha de Reprodução */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-primary shadow-[0_0_8px_rgba(255,122,41,0.8)] pointer-events-none transition-all"
                style={{
                  left: `${(previewTime / duration) * 100}%`,
                }}
              >
                <div className="size-2 -ml-[3px] rounded-full bg-primary" />
              </div>
            </div>

            {/* Trilha de Narração */}
            <div
              className="flex h-3 items-center rounded bg-primary/20 px-1 overflow-hidden"
              title="Faixa da Narração"
            >
              <span className="text-[9px] uppercase tracking-wider text-primary font-bold mr-1">
                Voz
              </span>
              <span className="h-1.5 flex-1 rounded-sm bg-primary/80" />
            </div>

            {/* Trilha de Música */}
            {music && (
              <div
                className="flex h-3 items-center rounded bg-accent/20 px-1 overflow-hidden"
                style={{ opacity: Math.max(0.3, effectiveMusicVolume) }}
                title="Faixa de Trilha Sonora"
              >
                <span className="text-[9px] uppercase tracking-wider text-accent font-bold mr-1">
                  BGM
                </span>
                <span className="h-1.5 flex-1 rounded-sm bg-accent/80" />
              </div>
            )}
          </div>

          {/* Estatísticas e Informações do Projeto */}
          <dl className="mt-4 space-y-1.5 border-t border-border pt-3">
            <Row label="Duração Total" value={formatTime(duration, true)} />
            <Row label="Total de Imagens" value={`${images.length}`} />
            <Row label="Tempo por Imagem" value={`${perImage.toFixed(2).replace(".", ",")} s`} />
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
