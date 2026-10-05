import { useEffect, useRef, useState } from "react";
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
import { Progress } from "@/components/ui/progress";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { renderVideoOnServer, buildDownloadUrl } from "@/lib/video/server-render";
import { drawFrame } from "@/lib/video/draw";
import { VIDEO_PRESETS, type MotionEffect, type PresetKey } from "@/lib/video/types";
import { GoogleDriveUpload } from "./GoogleDriveUpload";

const MOTION_EFFECTS: Array<{ value: MotionEffect; label: string; detail: string }> = [
  { value: "ken-burns", label: "Ken Burns", detail: "Zoom com deslocamento diagonal" },
  { value: "zoom", label: "Zoom suave", detail: "Aproximação central discreta" },
  { value: "pan", label: "Panorâmica", detail: "Movimento horizontal lento" },
  { value: "dissolve", label: "Dissolução", detail: "Transição gradual entre imagens" },
  { value: "zoom-out", label: "Zoom reverso", detail: "Afastamento central suave" },
];

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
    motionEffect,
    setMotionEffect,
    preferredFormat,
    setPreferredFormat,
    rendering,
    setRendering,
    progress,
    setProgress,
    previewTime,
    setPreviewTime,
    result,
    setResult,
    error,
    setError,
    projectName,
  } = useVideoProject();

  const previewRef = useRef<HTMLCanvasElement>(null);
  const cancelRef = useRef({ cancelled: false });
  const [renderStage, setRenderStage] = useState<"preparing" | "uploading" | "encoding">(
    "preparing",
  );
  const [renderDetail, setRenderDetail] = useState("");
  const [testingEffect, setTestingEffect] = useState<MotionEffect | null>(null);
  const [effectTestTime, setEffectTestTime] = useState(0);
  const [smoothPreviewTime, setSmoothPreviewTime] = useState(0);
  const smoothPreviewRef = useRef(0);

  useEffect(() => {
    if (!testingEffect || duration <= 0) return;
    const startedAt = performance.now();
    const sampleDuration = 30;
    const previewSpan = Math.min(duration, Math.max(0.1, perImage * Math.min(3, images.length)));
    const previewFps = Math.max(24, Math.min(60, fps));
    let lastDrawAt = 0;
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      if (elapsed >= sampleDuration) {
        setEffectTestTime(0);
        setTestingEffect(null);
        return;
      }
      if (now - lastDrawAt >= 1000 / previewFps) {
        lastDrawAt = now;
        setEffectTestTime((elapsed / sampleDuration) * previewSpan);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, fps, images.length, perImage, testingEffect]);

  // O servidor informa o tempo em amostras periódicas. Interpola apenas a exibição
  // entre duas amostras; o progresso e o vídeo final continuam sendo os valores reais.
  useEffect(() => {
    if (!rendering || renderStage !== "encoding") return;
    const from = smoothPreviewRef.current;
    const to = Math.max(from, previewTime);
    const startedAt = performance.now();
    const transitionMs = 850;
    let frame = 0;
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - startedAt) / transitionMs);
      const eased = ratio * ratio * (3 - 2 * ratio);
      const next = from + (to - from) * eased;
      smoothPreviewRef.current = next;
      setSmoothPreviewTime(next);
      if (ratio < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewTime, renderStage, rendering]);

  // O preview é apenas uma amostra visual leve. A exportação completa continua
  // sendo feita exclusivamente pelo FFmpeg nativo no servidor.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || (result && !testingEffect) || !images.length || duration <= 0) return;
    const { width, height } = VIDEO_PRESETS[preset];
    canvas.width = Math.round(width / 2);
    canvas.height = Math.round(height / 2);
    const context = canvas.getContext("2d");
    if (!context) return;
    drawFrame(
      context,
      images.map((image) => image.element),
      testingEffect
        ? effectTestTime
        : rendering && renderStage === "encoding"
          ? smoothPreviewTime
          : 0,
      duration,
      canvas.width,
      canvas.height,
      showCaptions ? captions : null,
      {
        kenBurns,
        fade: Math.min(0.6, perImage / 4),
        motionEffect: testingEffect ?? motionEffect,
      },
    );
  }, [
    captions,
    duration,
    images,
    kenBurns,
    motionEffect,
    perImage,
    preset,
    smoothPreviewTime,
    renderStage,
    rendering,
    result,
    showCaptions,
    effectTestTime,
    testingEffect,
  ]);

  // Validação dos requisitos para renderização
  const hasScript = Boolean(script.trim());
  const hasImages = images.length > 0;
  const hasNarration = Boolean(narration);
  const isReadyToRender = hasImages && hasNarration;
  const readyImageCount = images.filter((media) =>
    media.kind === "video"
      ? media.element instanceof HTMLVideoElement && media.element.videoWidth > 0
      : media.element instanceof HTMLImageElement &&
        media.element.complete &&
        media.element.naturalWidth > 0,
  ).length;

  const handleRender = async () => {
    if (!narration || !images.length) return;
    setError(null);
    setResult(null);
    setProgress(0);
    setPreviewTime(0);
    smoothPreviewRef.current = 0;
    setSmoothPreviewTime(0);
    setRenderStage("preparing");
    setRenderDetail("");
    setRendering(true);
    cancelRef.current = { cancelled: false };

    try {
      const { width, height } = VIDEO_PRESETS[preset];
      const renderResult = await renderVideoOnServer({
        images,
        narration,
        music,
        musicVolume: effectiveMusicVolume,
        narrationVolume: narrationVolume / 100,
        captions: showCaptions ? captions : null,
        width,
        height,
        fps,
        duration,
        kenBurns,
        motionEffect,
        fade: Math.min(0.6, perImage / 4),
        format: preferredFormat,
        onProgress: (value, stage, detail, timeSec) => {
          setRenderStage(stage);
          setRenderDetail(detail || "");
          setProgress(value * 100);
          if (stage === "encoding" && Number.isFinite(timeSec)) {
            setPreviewTime(Math.max(0, Math.min(duration, timeSec ?? 0)));
          }
        },
        cancelRef: cancelRef.current,
      });

      setResult({
        url: renderResult.url,
        extension: preferredFormat,
        size: renderResult.size,
      });
      setProgress(100);
      setPreviewTime(duration);
    } catch (e) {
      if (cancelRef.current.cancelled || (e instanceof Error && e.message === "CANCELLED")) {
        setError(null);
        setProgress(0);
        return;
      }
      setError(e instanceof Error ? e.message : "Falha ao montar o vídeo.");
    } finally {
      setRendering(false);
    }
  };

  return (
    <StepCard
      index={6}
      title="Montar o vídeo"
      description="Geração com imagens e/ou vídeos, narração, música e legendas sincronizadas."
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
              <span>Etapa 2: Pelo menos 1 imagem ou vídeo</span>
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
            <strong>{readyImageCount}</strong> de <strong>{images.length}</strong> mídias prontas
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

        <div className="min-w-0 sm:col-span-2">
          <Label className="text-xs text-muted-foreground">Efeito visual — escolha apenas um</Label>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {MOTION_EFFECTS.map((effect) => {
              const selected = motionEffect === effect.value;
              const testing = testingEffect === effect.value;
              return (
                <div
                  key={effect.value}
                  className="rounded-lg border bg-secondary/20 p-2 transition-colors"
                  style={{
                    borderColor: selected ? "var(--primary)" : "var(--border)",
                    boxShadow: selected ? "0 0 0 1px var(--primary)" : "none",
                  }}
                >
                  <input
                    id={`motion-effect-${effect.value}`}
                    type="radio"
                    name="motion-effect"
                    value={effect.value}
                    checked={selected}
                    onChange={() => setMotionEffect(effect.value)}
                    className="sr-only"
                  />
                  <label
                    htmlFor={`motion-effect-${effect.value}`}
                    className="block w-full cursor-pointer text-left focus:outline-none"
                  >
                    <span className="flex items-center justify-between gap-1 text-xs font-semibold text-foreground">
                      {effect.label}
                      {selected && <CheckCircle2 className="size-3.5 text-primary" />}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">
                      {effect.detail}
                    </span>
                    {selected && (
                      <span className="mt-1 block text-[9px] font-bold uppercase tracking-wide text-primary">
                        Selecionado
                      </span>
                    )}
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      if (testing) {
                        setTestingEffect(null);
                        setEffectTestTime(0);
                        return;
                      }
                      setEffectTestTime(0);
                      setTestingEffect(effect.value);
                    }}
                    disabled={!images.length || rendering}
                    className="mt-2 text-[10px] font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {testing ? "Parar preview" : "Testar no preview"}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Testar não altera a seleção. Clique no nome do efeito para escolhê-lo.
          </p>
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
            asChild
          >
            <a
              href={buildDownloadUrl(
                result.url,
                `${projectName.toLowerCase().replace(/[^a-z0-9]/g, "-")}.${result.extension}`,
              )}
              download={`${projectName.toLowerCase().replace(/[^a-z0-9]/g, "-")}.${result.extension}`}
            >
              <Download className="size-4" /> Baixar Vídeo {result.extension.toUpperCase()} (
              {(result.size / 1024 / 1024).toFixed(1)} MB)
            </a>
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
              {renderStage === "preparing"
                ? `Preparando mídias (${Math.round(progress)}%)`
                : renderStage === "uploading"
                  ? "Enviando mídias ao servidor..."
                  : `Montando vídeo no FFmpeg do servidor (${Math.round(progress)}%)`}
            </span>
            <span className="text-foreground/80 font-mono font-medium text-xs bg-background/80 px-2 py-0.5 rounded border border-border">
              {renderStage === "encoding"
                ? `${formatTime(Math.min(duration, previewTime))} / ${formatTime(duration)}`
                : renderStage === "preparing"
                  ? renderDetail || "Preparação local"
                  : renderDetail || "Enviando ao servidor"}
            </span>
          </div>
          <Progress value={progress} className="h-2.5" />
          <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
            {renderStage === "preparing"
              ? "Convertendo uma mídia por vez no navegador, sem executar o FFmpeg localmente."
              : renderStage === "uploading"
                ? "O pacote foi preparado e está sendo enviado ao servidor."
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
          className={`w-full h-full object-contain ${result && !testingEffect ? "hidden" : "block"}`}
        />
        {result && !testingEffect && (
          <video src={result.url} controls className="w-full h-full object-contain" />
        )}
      </div>
    </StepCard>
  );
}
