import { useState } from "react";
import {
  AudioLines,
  Sparkles,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Play,
  Pause,
  Copy,
  Quote,
  LayoutGrid,
  List,
} from "lucide-react";
import { StepCard } from "./StepCard";
import { FileDrop } from "./FileDrop";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { DEFAULT_SCENE_MIN_PAUSE_SEC, getSceneScriptText } from "@/lib/video/scenes";
import { FileLoadIndicator } from "./FileLoadIndicator";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function NarrationStep() {
  const {
    narration,
    loadAudio,
    duration,
    detectedScenes,
    sceneMinPauseSec,
    setSceneMinPauseSec,
    minSceneDurationSec,
    setMinSceneDurationSec,
    fileLoadProgress,
    script,
    captions,
    playingNarrationPreview,
    playNarrationPreview,
    stopNarrationPreview,
    registerNarrationPlayer,
  } = useVideoProject();

  const [showSceneControls, setShowSceneControls] = useState(false);
  const [viewMode, setViewMode] = useState<"detailed" | "compact">("detailed");

  const copyAllScenes = () => {
    if (!detectedScenes.length) return;
    const text = detectedScenes
      .map((sc, i) => {
        const speech = getSceneScriptText(
          captions,
          sc.speechStart,
          sc.speechEnd,
          script,
          i,
          detectedScenes.length,
        );
        return `Cena ${i + 1} (${formatTime(sc.start)} - ${formatTime(sc.end)} | ${sc.duration.toFixed(1)}s):\n"${speech || "(sem texto)"}"\n`;
      })
      .join("\n");

    void navigator.clipboard.writeText(text);
    toast.success("Roteiro e trechos de todas as cenas copiados!");
  };

  return (
    <StepCard
      index={2}
      title="Narração"
      description="A narração é o maestro do vídeo: suas pausas e trechos definem exatamente o número e a duração de cada cena."
      done={!!narration}
    >
      <FileDrop accept="audio/*" onFiles={(files) => files[0] && loadAudio(files[0], "narration")}>
        <AudioLines className="size-6" />
        <span>{narration ? narration.name : "Arraste o áudio da narração (mp3, wav, m4a)"}</span>
      </FileDrop>
      <FileLoadIndicator state={fileLoadProgress.narration} />

      {narration && (
        <div className="mt-4 space-y-3">
          <audio
            ref={registerNarrationPlayer}
            controls
            src={narration.url}
            className="w-full"
            onPlay={stopNarrationPreview}
          />

          {/* Destaque das Cenas Detectadas */}
          <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 text-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary shrink-0" />
                <div>
                  <span className="font-semibold text-foreground text-sm">
                    {detectedScenes.length} cena(s) identificada(s) na narração
                  </span>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Duração total: <strong>{formatTime(duration, true)}</strong> · Média de{" "}
                    <strong>
                      {(duration / Math.max(1, detectedScenes.length)).toFixed(1).replace(".", ",")}
                      s
                    </strong>{" "}
                    por cena
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSceneControls(!showSceneControls)}
                  className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/60 px-2.5 py-1 text-[11px] text-foreground hover:bg-background transition-colors"
                >
                  <SlidersHorizontal className="size-3 text-primary" />
                  <span>Ajustar sensibilidade</span>
                  {showSceneControls ? (
                    <ChevronUp className="size-3 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="size-3 text-muted-foreground" />
                  )}
                </button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyAllScenes}
                  className="h-7 text-[11px] gap-1 px-2.5"
                  title="Copiar todas as cenas com falas e tempos para prompts de IA"
                >
                  <Copy className="size-3 text-primary" />
                  <span>Copiar cenas</span>
                </Button>
              </div>
            </div>

            {/* Controles finos de corte de cena */}
            {showSceneControls && (
              <div className="grid gap-4 border-t border-border/50 pt-3 sm:grid-cols-2 text-xs">
                <div>
                  <Label className="text-[11px] text-muted-foreground">
                    Pausa mínima para nova cena: <strong>{sceneMinPauseSec.toFixed(2)}s</strong>
                  </Label>
                  <Slider
                    value={[sceneMinPauseSec]}
                    min={0.4}
                    max={1.5}
                    step={0.05}
                    onValueChange={([v]) => setSceneMinPauseSec(v ?? DEFAULT_SCENE_MIN_PAUSE_SEC)}
                    className="mt-2"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Pausas menores são tratadas como respiração natural dentro da mesma cena.
                  </p>
                </div>

                <div>
                  <Label className="text-[11px] text-muted-foreground">
                    Duração mínima por cena: <strong>{minSceneDurationSec.toFixed(1)}s</strong>
                  </Label>
                  <Slider
                    value={[minSceneDurationSec]}
                    min={1.0}
                    max={6.0}
                    step={0.5}
                    onValueChange={([v]) => setMinSceneDurationSec(v ?? 2.0)}
                    className="mt-2"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Evita cenas excessivamente rápidas se houver pausas frequentes.
                  </p>
                </div>
              </div>
            )}

            {/* Lista dos Trechos de Cena com Fala */}
            {detectedScenes.length > 0 && (
              <div className="border-t border-border/40 pt-2.5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                    <Quote className="size-3 text-primary" />
                    Trechos de fala de cada cena:
                  </span>
                  <div className="flex items-center gap-1 bg-background/50 p-0.5 rounded-lg border border-border/60">
                    <button
                      type="button"
                      onClick={() => setViewMode("detailed")}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 ${
                        viewMode === "detailed"
                          ? "bg-primary text-primary-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <List className="size-3" />
                      Com falas
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode("compact")}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 ${
                        viewMode === "compact"
                          ? "bg-primary text-primary-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <LayoutGrid className="size-3" />
                      Compacto
                    </button>
                  </div>
                </div>

                {viewMode === "detailed" ? (
                  <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                    {detectedScenes.map((sc, i) => {
                      const sceneText = getSceneScriptText(
                        captions,
                        sc.speechStart,
                        sc.speechEnd,
                        script,
                        i,
                        detectedScenes.length,
                      );
                      const previewKey = `scene:${i}`;
                      const isPlaying = playingNarrationPreview === previewKey;

                      return (
                        <div
                          key={i}
                          className="rounded-lg border border-border/70 bg-background/80 p-2.5 transition-colors hover:border-primary/50"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="size-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
                                {i + 1}
                              </span>
                              <span className="font-semibold text-foreground text-xs">
                                Cena {i + 1}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {formatTime(sc.start)} – {formatTime(sc.end)}
                              </span>
                              <span className="rounded bg-primary/10 px-1.5 py-0.2 font-mono text-[10px] text-primary font-semibold">
                                {sc.duration.toFixed(1)}s
                              </span>
                            </div>

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void playNarrationPreview(
                                    previewKey,
                                    sc.speechStart,
                                    sc.speechEnd,
                                  )
                                }
                                className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-primary transition-colors"
                                title={
                                  isPlaying
                                    ? "Pausar áudio"
                                    : `Ouvir fala detectada (${formatTime(sc.speechStart, true)} – ${formatTime(sc.speechEnd, true)})`
                                }
                              >
                                {isPlaying ? (
                                  <Pause className="size-3 text-primary animate-pulse" />
                                ) : (
                                  <Play className="size-3 text-primary" />
                                )}
                                <span className={isPlaying ? "text-primary font-bold" : ""}>
                                  {isPlaying ? "Ouvindo" : "Ouvir"}
                                </span>
                              </button>

                              {sceneText && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(sceneText);
                                    toast.success(`Texto da Cena ${i + 1} copiado!`);
                                  }}
                                  className="text-muted-foreground hover:text-primary transition-colors pl-1.5 border-l border-border/60"
                                  title="Copiar texto da cena"
                                >
                                  <Copy className="size-3" />
                                </button>
                              )}
                            </div>
                          </div>

                          {sceneText ? (
                            <p
                              className="text-[11px] leading-relaxed text-foreground/90 italic pl-7 cursor-default select-text"
                              title={sceneText}
                            >
                              "{sceneText}"
                            </p>
                          ) : (
                            <p className="text-[10px] italic text-muted-foreground/60 pl-7">
                              {script.trim()
                                ? "(Ajustando trecho da fala...)"
                                : "(Insira o roteiro na Etapa 1 para visualizar a narração aqui)"}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
                    {detectedScenes.map((sc, i) => {
                      const sceneText = getSceneScriptText(
                        captions,
                        sc.speechStart,
                        sc.speechEnd,
                        script,
                        i,
                        detectedScenes.length,
                      );
                      const previewKey = `scene:${i}`;
                      const isPlaying = playingNarrationPreview === previewKey;

                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() =>
                            void playNarrationPreview(previewKey, sc.speechStart, sc.speechEnd)
                          }
                          title={sceneText ? `Cena ${i + 1}: "${sceneText}"` : `Cena ${i + 1}`}
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-mono transition-colors text-left ${
                            isPlaying
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border/60 bg-background/70 hover:border-primary/40"
                          }`}
                        >
                          <span className="font-bold text-primary">#{i + 1}</span>
                          <span>
                            {formatTime(sc.start)} – {formatTime(sc.end)}
                          </span>
                          <span className="rounded bg-primary/10 px-1 text-primary font-semibold">
                            {sc.duration.toFixed(1)}s
                          </span>
                          {isPlaying ? (
                            <Pause className="size-2.5 text-primary animate-pulse" />
                          ) : (
                            <Play className="size-2.5 text-muted-foreground" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </StepCard>
  );
}
