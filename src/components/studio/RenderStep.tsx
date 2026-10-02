import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Download,
  Play,
  Square,
  AlertCircle,
  CheckCircle2,
  FileVideo,
  Sparkles,
} from "lucide-react";
import { StepCard } from "./StepCard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { renderVideoOnServer } from "@/lib/video/server-render";
import { drawFrame } from "@/lib/video/draw";
import { VIDEO_PRESETS, type PresetKey } from "@/lib/video/types";
import { downloadBlob } from "@/lib/utils";
import { GoogleDriveUpload } from "./GoogleDriveUpload";

export function RenderStep() {
  const {
    script,
    images,
    narration,
    music,
    captions,
    showCaptions,
    effectiveMusicVolume,
    narrationVolume,
    perImage,
    duration,
    preset,
    setPreset,
    fps,
    setFps,
    kenBurns,
    setKenBurns,
    preferredFormat,
    setPreferredFormat,
    rendering,
    setRendering,
    progress,
    setProgress,
    result,
    setResult,
    error,
    setError,
    projectName,
  } = useVideoProject();

  const previewRef = useRef<HTMLCanvasElement>(null);
  const cancelRef = useRef({ cancelled: false });
  const [renderStage, setRenderStage] = useState<"uploading" | "encoding">("uploading");
  const [liveProgress, setLiveProgress] = useState(0);

  // O preview é apenas uma amostra visual leve. A exportação completa continua
  // sendo feita exclusivamente pelo FFmpeg nativo no servidor.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || result || !images.length || duration <= 0) return;
    const { width, height } = VIDEO_PRESETS[preset];
    canvas.width = Math.round(width / 2);
    canvas.height = Math.round(height / 2);
    const context = canvas.getContext("2d");
    if (!context) return;
    drawFrame(
      context,
      images.map((image) => image.element),
      0,
      duration,
      canvas.width,
      canvas.height,
      showCaptions ? captions : null,
      { kenBurns, fade: Math.min(0.6, perImage / 4) },
    );
  }, [captions, duration, images, kenBurns, perImage, preset, result, showCaptions]);

  // Validação dos requisitos para renderização
  const hasScript = Boolean(script.trim());
  const hasImages = images.length > 0;
  const hasNarration = Boolean(narration);
  const isReadyToRender = hasImages && hasNarration;
  const readyImageCount = images.filter(
    (image) => image.element.complete && image.element.naturalWidth > 0,
  ).length;

  const handleRender = async () => {
    if (!narration || !images.length) return;
    setError(null);
    setResult(null);
    setProgress(0);
    setLiveProgress(0);
    setRenderStage("uploading");
    setRendering(true);
    cancelRef.current = { cancelled: false };

    try {
      const { width, height } = VIDEO_PRESETS[preset];
      const outputBlob = await renderVideoOnServer({
        images,
        narration,
        music,
        musicVolume: effectiveMusicVolume,
        narrationVolume: narrationVolume / 100,
        captions: showCaptions ? captions : null,
        width,
        height,
        fps,
        kenBurns,
        fade: Math.min(0.6, perImage / 4),
        format: preferredFormat,
        onProgress: (value, stage) => {
          const percent = value * 100;
          flushSync(() => {
            setRenderStage(stage);
            setLiveProgress((current) => Math.max(current, percent));
          });
          setProgress(percent);
        },
        cancelRef: cancelRef.current,
      });

      setResult({
        url: URL.createObjectURL(outputBlob),
        extension: preferredFormat,
        size: outputBlob.size,
      });
      setProgress(100);
      setLiveProgress(100);
    } catch (e) {
      if (cancelRef.current.cancelled || (e instanceof Error && e.message === "CANCELLED")) {
        setError(null);
        setProgress(0);
        setLiveProgress(0);
        return;
      }
      setError(e instanceof Error ? e.message : "Falha ao montar o vídeo.");
    } finally {
      setRendering(false);
    }
  };

  const displayedProgress = rendering ? liveProgress : progress;

  return (
    <StepCard
      index={6}
      title="Montar o vídeo"
      description="Geração do vídeo com sincronia de narração, música, legendas e animação de imagens."
      done={!!result}
    >
      {/* Validação de Requisitos (Fase 1.5) */}
      {!isReadyToRender && (
        <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-500">
            <AlertCircle className="size-4 shrink-0" />
            <span>Itens pendentes para liberar a montagem do vídeo:</span>
          </div>
          <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
            <div
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 ${
                hasScript
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-background/50 text-muted-foreground"
              }`}
            >
              {hasScript ? (
                <CheckCircle2 className="size-3.5 text-primary shrink-0" />
              ) : (
                <span className="size-1.5 rounded-full bg-muted-foreground shrink-0" />
              )}
              <span>Etapa 1: Roteiro (para legendas)</span>
            </div>

            <div
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 ${
                hasImages
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-background/50 text-muted-foreground"
              }`}
            >
              {hasImages ? (
                <CheckCircle2 className="size-3.5 text-primary shrink-0" />
              ) : (
                <span className="size-1.5 rounded-full bg-amber-500 shrink-0" />
              )}
              <span>Etapa 2: Pelo menos 1 imagem</span>
            </div>

            <div
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 ${
                hasNarration
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-background/50 text-muted-foreground"
              }`}
            >
              {hasNarration ? (
                <CheckCircle2 className="size-3.5 text-primary shrink-0" />
              ) : (
                <span className="size-1.5 rounded-full bg-amber-500 shrink-0" />
              )}
              <span>Etapa 3: Narração (áudio)</span>
            </div>
          </div>
        </div>
      )}

      {/* Opções de Vídeo e Formato */}
      {isReadyToRender && (
        <div className="mb-5 grid gap-2 rounded-xl border border-primary/30 bg-primary/10 p-4 text-xs sm:grid-cols-3">
          <span>
            <strong>{readyImageCount}</strong> de <strong>{images.length}</strong> imagens prontas
          </span>
          <span>
            Narração: <strong>{formatTime(duration, true)}</strong>
          </span>
          <span>
            Áudio final: <strong>narração{music ? " + música" : ""}</strong>
          </span>
        </div>
      )}

      {/* Opções de Vídeo e Formato */}
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <div className="min-w-0">
          <Label className="text-xs text-muted-foreground">Formato de Saída</Label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant={preferredFormat === "mp4" ? "default" : "secondary"}
              onClick={() => setPreferredFormat("mp4")}
              className="gap-1 text-xs"
            >
              <FileVideo className="size-3.5" />
              MP4 <span className="text-[10px] opacity-75 font-normal">(YouTube)</span>
            </Button>
            <Button
              size="sm"
              variant={preferredFormat === "webm" ? "default" : "secondary"}
              onClick={() => setPreferredFormat("webm")}
              className="text-xs"
            >
              WebM
            </Button>
          </div>
        </div>

        <div className="min-w-0">
          <Label className="text-xs text-muted-foreground">Resolução</Label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(Object.keys(VIDEO_PRESETS) as PresetKey[]).map((key) => (
              <Button
                key={key}
                size="sm"
                variant={preset === key ? "default" : "secondary"}
                onClick={() => setPreset(key)}
                className="text-xs"
              >
                {key}
              </Button>
            ))}
          </div>
        </div>

        <div className="min-w-0">
          <Label className="text-xs text-muted-foreground">Taxa de Quadros (FPS)</Label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[24, 30, 60].map((f) => (
              <Button
                key={f}
                size="sm"
                variant={fps === f ? "default" : "secondary"}
                onClick={() => setFps(f)}
                className="text-xs"
              >
                {f} fps
              </Button>
            ))}
          </div>
        </div>

        <div className="min-w-0">
          <Label className="text-xs text-muted-foreground">Movimento da imagem</Label>
          <div className="mt-2 flex min-h-9 items-center gap-2.5">
            <Switch id="kb" checked={kenBurns} onCheckedChange={setKenBurns} />
            <Label htmlFor="kb" className="cursor-pointer text-xs font-normal leading-tight">
              Efeito Ken Burns — zoom suave
            </Label>
          </div>
        </div>
      </div>

      {/* Botões de Ação */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          onClick={handleRender}
          disabled={rendering || !isReadyToRender}
          size="lg"
          className="gap-2 shadow-lg"
          style={{ background: isReadyToRender ? "var(--gradient-studio)" : undefined }}
        >
          <Play className="size-4" /> Montar vídeo em {preferredFormat.toUpperCase()}
        </Button>

        {rendering && (
          <Button
            variant="destructive"
            onClick={() => {
              cancelRef.current.cancelled = true;
            }}
            className="gap-2"
          >
            <Square className="size-4" /> Cancelar Montagem
          </Button>
        )}

        {result && (
          <Button
            variant="secondary"
            className="gap-2 border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
            onClick={() =>
              fetch(result.url)
                .then((r) => r.blob())
                .then((b) =>
                  downloadBlob(
                    b,
                    `${projectName.toLowerCase().replace(/[^a-z0-9]/g, "-")}.${result.extension}`,
                  ),
                )
            }
          >
            <Download className="size-4" /> Baixar Vídeo {result.extension.toUpperCase()} (
            {(result.size / 1024 / 1024).toFixed(1)} MB)
          </Button>
        )}
      </div>

      {/* Upload para Google Drive (Fase pós-render) */}
      {result && (
        <GoogleDriveUpload
          videoUrl={result.url}
          fileName={`${projectName.toLowerCase().replace(/[^a-z0-9]/g, "-")}.${result.extension}`}
          fileSize={result.size}
        />
      )}

      {/* Progresso de Montagem */}
      {rendering && (
        <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between text-xs mb-2 gap-2">
            <span className="font-semibold flex items-center gap-1.5 text-primary">
              <Sparkles className="size-3.5 animate-pulse text-primary" />
              {renderStage === "uploading"
                ? `Enviando mídias ao servidor (${Math.round(displayedProgress)}%)`
                : `Montando vídeo no FFmpeg do servidor (${Math.round(displayedProgress)}%)`}
            </span>
            <span className="text-foreground/80 font-mono font-medium text-xs bg-background/80 px-2 py-0.5 rounded border border-border">
              {renderStage === "uploading"
                ? "Progresso real do envio"
                : `${formatTime(Math.min(duration, (Math.max(0, displayedProgress - 10) / 89) * duration))} / ${formatTime(duration)}`}
            </span>
          </div>
          <Progress value={displayedProgress} className="h-2.5" />
          <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
            {renderStage === "uploading"
              ? "Enviando imagens, narração, música e legendas. Falhas de rede e timeouts serão informados automaticamente."
              : "Gerando imagens, legendas e áudio em H.264/AAC no FFmpeg nativo do servidor."}
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Preview Player / Canvas */}
      <div className="mt-5 overflow-hidden rounded-xl border border-border bg-black shadow-inner relative aspect-video flex items-center justify-center">
        <canvas
          ref={previewRef}
          className={`w-full h-full object-contain ${result ? "hidden" : "block"}`}
        />
        {result && <video src={result.url} controls className="w-full h-full object-contain" />}
      </div>
    </StepCard>
  );
}
