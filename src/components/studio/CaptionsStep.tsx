import { useState } from "react";
import {
  Subtitles,
  Sparkles,
  Play,
  Square,
  RotateCcw,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Volume2,
} from "lucide-react";
import { StepCard } from "./StepCard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime, toSRT } from "@/lib/video/captions";
import { downloadBlob } from "@/lib/utils";

export function CaptionsStep() {
  const {
    captions,
    showCaptions,
    setShowCaptions,
    maxChars,
    setMaxChars,
    narration,
    autoSyncCaptions,
    setAutoSyncCaptions,
    vadMinSilence,
    setVadMinSilence,
    pausesCount,
    isCustomizedCaptions,
    updateCaption,
    resetCaptionsToAuto,
    playingNarrationPreview,
    playNarrationPreview,
  } = useVideoProject();

  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <StepCard
      index={4}
      title="Legendas"
      description="Geradas a partir do roteiro e sincronizadas com as pausas reais da narração."
      done={captions.length > 0}
      aside={
        <div className="flex items-center gap-2">
          <Label htmlFor="cap" className="text-xs text-muted-foreground">
            no vídeo
          </Label>
          <Switch id="cap" checked={showCaptions} onCheckedChange={setShowCaptions} />
        </div>
      }
    >
      {/* Barra principal de configurações */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-48 flex-1">
          <Label className="text-xs text-muted-foreground">
            Máximo de caracteres por bloco: {maxChars}
          </Label>
          <Slider
            value={[maxChars]}
            min={40}
            max={140}
            step={5}
            onValueChange={([v]) => setMaxChars(v ?? 90)}
            className="mt-2"
          />
        </div>

        <Button
          variant="secondary"
          size="sm"
          disabled={!captions.length}
          onClick={() =>
            downloadBlob(new Blob([toSRT(captions)], { type: "text/plain" }), "legendas.srt")
          }
        >
          <Subtitles className="size-4" /> Baixar .srt
        </Button>
      </div>

      {/* Sincronização inteligente com detecção de pausas */}
      {narration && (
        <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary shrink-0" />
              <div>
                <span className="font-semibold text-foreground">
                  Sincronização Inteligente por Detecção de Silêncio (VAD)
                </span>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Detecta quando o narrador para de falar e pausa a legenda, evitando que fique
                  descasada.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {autoSyncCaptions && (
                <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-medium text-primary text-[11px]">
                  {pausesCount > 0 ? `${pausesCount} pausas detectadas` : "Análise em tempo real"}
                </span>
              )}
              <Switch
                checked={autoSyncCaptions}
                onCheckedChange={setAutoSyncCaptions}
                aria-label="Ativar sincronização inteligente de fala"
              />
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between border-t border-border/50 pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <SlidersHorizontal className="size-3" />
              <span>Ajustes finos de detecção de pausa</span>
              {showAdvanced ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>

            {isCustomizedCaptions && (
              <Button
                variant="ghost"
                size="sm"
                onClick={resetCaptionsToAuto}
                className="h-6 text-[11px] text-amber-500 hover:text-amber-400 gap-1 px-2"
              >
                <RotateCcw className="size-3" />
                Redefinir para o automático
              </Button>
            )}
          </div>

          {showAdvanced && (
            <div className="mt-3 grid gap-3 border-t border-border/40 pt-3 sm:grid-cols-2">
              <div>
                <Label className="text-[11px] text-muted-foreground">
                  Duração mínima de pausa: {vadMinSilence.toFixed(2)} s
                </Label>
                <Slider
                  value={[vadMinSilence]}
                  min={0.2}
                  max={0.8}
                  step={0.05}
                  onValueChange={([v]) => setVadMinSilence(v ?? 0.35)}
                  className="mt-1.5"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Silêncios menores que este valor são considerados respiração e não dividem frases.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Lista de Legendas */}
      {captions.length > 0 ? (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-[11px] text-muted-foreground px-1">
            <span>{captions.length} blocos de legenda gerados</span>
            <span>Clique no ícone de reprodução para ouvir o trecho exato</span>
          </div>

          <ul className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-secondary/30 p-2 text-sm">
            {captions.map((c, i) => {
              const prev = captions[i - 1];
              const pauseBefore = prev ? c.start - prev.end : 0;
              const hasPause = pauseBefore >= 0.4;
              const previewKey = `caption:${i}`;
              const isPlaying = playingNarrationPreview === previewKey;

              return (
                <li key={i} className="space-y-1">
                  {hasPause && (
                    <div className="flex items-center gap-2 py-0.5 px-3 text-[10px] font-mono text-muted-foreground/75 bg-background/40 rounded">
                      <span className="size-1.5 rounded-full bg-amber-500/80" />
                      <span>Pausa na narração de {pauseBefore.toFixed(1)}s</span>
                    </div>
                  )}

                  <div className="flex items-start gap-2.5 rounded-lg border border-border/40 bg-card/40 px-2.5 py-2 hover:bg-secondary/60 transition-colors">
                    {/* Botão de ouvir trecho */}
                    <button
                      type="button"
                      onClick={() => void playNarrationPreview(previewKey, c.start, c.end)}
                      disabled={!narration}
                      title="Ouvir este trecho de áudio"
                      className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors ${
                        isPlaying
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background/60 text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      }`}
                    >
                      {isPlaying ? (
                        <Square className="size-3 fill-current" />
                      ) : (
                        <Play className="size-3 fill-current ml-0.5" />
                      )}
                    </button>

                    {/* Timestamp */}
                    <div className="shrink-0 flex flex-col font-mono text-[11px] text-muted-foreground">
                      <span>{formatTime(c.start, true)}</span>
                      <span className="text-[10px] opacity-60">até {formatTime(c.end, true)}</span>
                    </div>

                    {/* Texto da legenda */}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs leading-relaxed text-foreground select-text">
                        {c.text}
                      </p>
                    </div>

                    {/* Ajuste fino rápido (+/- 0.2s) */}
                    <div className="flex items-center gap-1 shrink-0 opacity-40 hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() =>
                          updateCaption(i, {
                            start: Math.max(0, Number((c.start - 0.2).toFixed(2))),
                          })
                        }
                        title="Adiantar início em 0.2s"
                        className="px-1.5 py-0.5 rounded text-[10px] bg-secondary hover:bg-secondary/80 border border-border/50"
                      >
                        -0.2s
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateCaption(i, {
                            start: Number((c.start + 0.2).toFixed(2)),
                          })
                        }
                        title="Atrasar início em 0.2s"
                        className="px-1.5 py-0.5 rounded text-[10px] bg-secondary hover:bg-secondary/80 border border-border/50"
                      >
                        +0.2s
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Carregue o roteiro e a narração para gerar as legendas sincronizadas.
        </p>
      )}
    </StepCard>
  );
}
