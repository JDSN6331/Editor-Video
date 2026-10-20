import { useRef, useState } from "react";
import {
  Image as ImageIcon,
  Film,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  Plus,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Copy,
  Play,
  Pause,
  Quote,
} from "lucide-react";
import { StepCard } from "./StepCard";
import { FileDrop } from "./FileDrop";
import { Button } from "@/components/ui/button";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { FileLoadIndicator } from "./FileLoadIndicator";
import { formatTime } from "@/lib/video/captions";
import { getSceneScriptText } from "@/lib/video/scenes";
import { isFilledMedia } from "@/lib/video/types";
import { toast } from "sonner";

export function ImagesStep() {
  const {
    images,
    setImages,
    addImages,
    removeImage,
    moveImage,
    reorderImages,
    replaceImageAt,
    setImageForScene,
    perImage,
    scenes,
    detectedScenes,
    narration,
    captions,
    script,
    fileLoadProgress,
    playingNarrationPreview,
    playNarrationPreview,
  } = useVideoProject();

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverSlotIndex, setDragOverSlotIndex] = useState<number | null>(null);
  const slotInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `${index}`);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;
    reorderImages(draggedIndex, targetIndex);
    setDraggedIndex(null);
  };

  // Upload direto para um slot de cena específico
  const handleSlotFileChange = (e: React.ChangeEvent<HTMLInputElement>, sceneIndex: number) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (sceneIndex > images.length) {
      toast.info("Preencha as cenas anteriores antes de adicionar esta mídia.");
      e.target.value = "";
      return;
    }
    if (sceneIndex < images.length) {
      void replaceImageAt(sceneIndex, file);
    } else {
      void setImageForScene(sceneIndex, file);
    }
    e.target.value = "";
  };

  // Drag and drop de arquivo do computador direto para o slot vazio
  const handleSlotFileDrop = (e: React.DragEvent, sceneIndex: number) => {
    e.preventDefault();
    setDragOverSlotIndex(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (sceneIndex > images.length) {
      toast.info("Preencha as cenas anteriores antes de adicionar esta mídia.");
      return;
    }
    if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
      if (sceneIndex < images.length) {
        void replaceImageAt(sceneIndex, file);
      } else {
        void setImageForScene(sceneIndex, file);
      }
    }
  };

  // Grade 1:1 entre trechos detectados e mídias
  const hasNarration = Boolean(narration);
  const totalSlots =
    hasNarration && detectedScenes.length > 0 ? detectedScenes.length : images.length;
  const filledSlotsCount = images.slice(0, totalSlots).filter(isFilledMedia).length;
  const totalFilledMedia = images.filter(isFilledMedia).length;
  const extraMediaCount = images.slice(totalSlots).filter(isFilledMedia).length;
  const isAllFilled = totalSlots > 0 && filledSlotsCount === totalSlots;

  const copyAllScenePrompts = () => {
    if (totalSlots === 0) return;
    const lines = Array.from({ length: totalSlots }, (_, i) => {
      const sceneTiming = detectedScenes[i] ?? scenes[i];
      const startTime = sceneTiming?.start ?? i * perImage;
      const endTime = sceneTiming?.end ?? (i + 1) * perImage;
      const speechStart = sceneTiming?.speechStart ?? startTime;
      const speechEnd = sceneTiming?.speechEnd ?? endTime;
      const durationSec = sceneTiming?.duration ?? perImage;
      const text = getSceneScriptText(captions, speechStart, speechEnd, script, i, totalSlots);
      return `Cena ${i + 1} (${formatTime(startTime)} - ${formatTime(endTime)} | ${durationSec.toFixed(1)}s):\n"${text || "(sem fala)"}"\n`;
    });
    void navigator.clipboard.writeText(lines.join("\n"));
    toast.success("Roteiro e falas de todas as cenas copiados!");
  };

  return (
    <StepCard
      index={3}
      title="Imagens e vídeos das cenas"
      description={
        hasNarration
          ? "Cada cena mostra o trecho da narração e a duração exata para você escolher a melhor imagem ou vídeo."
          : "Carregue a narração na Etapa 2 para gerar os trechos exatos de cada cena, ou adicione mídias livremente."
      }
      done={totalFilledMedia > 0 && (!hasNarration || isAllFilled)}
      aside={
        totalFilledMedia > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setImages([])}>
            <Trash2 className="size-4" /> limpar todas
          </Button>
        ) : undefined
      }
    >
      {/* Upload em lote no topo */}
      <FileDrop accept="image/*,video/*" multiple onFiles={addImages}>
        <div className="flex items-center gap-1 text-primary">
          <ImageIcon className="size-6" />
          <Film className="size-6" />
        </div>
        <span>Arraste imagens ou vídeos, ou clique para adicionar em lote</span>
      </FileDrop>
      <FileLoadIndicator state={fileLoadProgress.images} />

      {/* Painel informativo quando a narração já definiu os trechos */}
      {hasNarration && detectedScenes.length > 0 && (
        <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary shrink-0" />
              <div>
                <span className="font-semibold text-foreground">
                  Trechos de Cena Detectados pela Narração: {detectedScenes.length} cenas
                </span>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Cada card abaixo contém a fala da narração correspondente para facilitar a escolha
                  da mídia.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={copyAllScenePrompts}
                className="h-7 text-[11px] gap-1 px-2.5 bg-background/60 hover:bg-background"
                title="Copiar lista de todas as cenas com falas e tempos para prompts de IA"
              >
                <Copy className="size-3 text-primary" />
                <span>Copiar todas as falas</span>
              </Button>

              <span
                className={`rounded-full px-2.5 py-0.5 font-medium text-[11px] flex items-center gap-1.5 ${
                  isAllFilled
                    ? "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30"
                    : "bg-primary/10 text-primary border border-primary/20"
                }`}
              >
                {isAllFilled ? (
                  <>
                    <CheckCircle2 className="size-3" />
                    Todas as {totalSlots} cenas preenchidas
                  </>
                ) : (
                  <>
                    <AlertCircle className="size-3" />
                    {filledSlotsCount} de {totalSlots} cenas preenchidas
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      )}

      {extraMediaCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
          <span>
            Há {extraMediaCount} mídia(s) além das {totalSlots} cenas detectadas. Remova o excesso
            para manter o encaixe 1:1.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImages((current) => current.slice(0, totalSlots))}
            className="h-7 text-[11px]"
          >
            Remover excedentes
          </Button>
        </div>
      )}

      {/* Grade de Cenas Encaixadas */}
      {totalSlots > 0 && (
        <div className="mt-5">
          <div className="mb-2.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {hasNarration
                ? "Grade de cenas (veja o trecho da fala e encaixe a imagem/vídeo ideal):"
                : "Mídias carregadas (arraste para reordenar):"}
            </span>
            {totalFilledMedia > 0 && (
              <span className="text-[11px] font-mono">{totalFilledMedia} mídia(s) no projeto</span>
            )}
          </div>

          <ul className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: totalSlots }, (_, i) => {
              const slot = images[i];
              const img = isFilledMedia(slot) ? slot : undefined;
              const sceneTiming = detectedScenes[i] ?? scenes[i];
              const startTime = sceneTiming?.start ?? i * perImage;
              const endTime = sceneTiming?.end ?? (i + 1) * perImage;
              const speechStart = sceneTiming?.speechStart ?? startTime;
              const speechEnd = sceneTiming?.speechEnd ?? endTime;
              const durationSec = sceneTiming?.duration ?? perImage;
              const isFilled = Boolean(img);
              const canFillSlot = Boolean(slot?.isPlaceholder) || i === images.length;
              const sceneText = getSceneScriptText(
                captions,
                speechStart,
                speechEnd,
                script,
                i,
                totalSlots,
              );
              const previewKey = `scene:${i}`;
              const isPlayingThisScene = playingNarrationPreview === previewKey;

              return (
                <li
                  key={img?.id ?? `empty-slot-${i}`}
                  draggable={isFilled}
                  onDragStart={isFilled ? (e) => handleDragStart(e, i) : undefined}
                  onDragOver={(e) => {
                    handleDragOver(e);
                    if (!isFilled) setDragOverSlotIndex(i);
                  }}
                  onDragLeave={() => {
                    if (!isFilled) setDragOverSlotIndex(null);
                  }}
                  onDrop={(e) => {
                    if (isFilled && draggedIndex !== null) {
                      handleDrop(e, i);
                    } else if (!isFilled) {
                      handleSlotFileDrop(e, i);
                    }
                  }}
                  onDragEnd={() => setDraggedIndex(null)}
                  className={`group relative flex flex-col justify-between overflow-hidden rounded-xl border transition-all ${
                    draggedIndex === i
                      ? "opacity-40 scale-95 border-primary border-dashed"
                      : isFilled
                        ? "border-border bg-card/60 hover:border-primary/50 hover:shadow-md"
                        : dragOverSlotIndex === i
                          ? "border-primary bg-primary/10 border-dashed ring-2 ring-primary/30"
                          : "border-border/70 border-dashed bg-secondary/15 hover:border-primary/40 hover:bg-secondary/25"
                  }`}
                >
                  {/* Cabeçalho do Card da Cena */}
                  <div className="border-b border-border/40 bg-background/80 px-3 py-2 backdrop-blur">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5 font-semibold text-xs text-foreground">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                          {i + 1}
                        </span>
                        <span className="whitespace-nowrap">Cena {i + 1}</span>
                      </div>

                      <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                        {durationSec.toFixed(1)}s
                      </span>
                    </div>
                    <span className="mt-1 block whitespace-nowrap pl-6.5 font-mono text-[10px] text-muted-foreground">
                      {formatTime(startTime)} – {formatTime(endTime)}
                    </span>
                  </div>

                  {/* Trecho da Narração correspondente à cena */}
                  <div className="px-3 py-2 bg-secondary/25 border-b border-border/30 text-xs">
                    <div className="flex items-center justify-between text-[10px] font-medium text-muted-foreground mb-1">
                      <span className="flex items-center gap-1 text-primary">
                        <Quote className="size-3 shrink-0" />
                        Roteiro associado à fala:
                      </span>
                      <div className="flex items-center gap-1.5">
                        {/* Botão de ouvir trecho de áudio */}
                        <button
                          type="button"
                          onClick={() =>
                            void playNarrationPreview(previewKey, speechStart, speechEnd)
                          }
                          disabled={!narration}
                          className="hover:text-primary transition-colors flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground disabled:opacity-40"
                          title={
                            isPlayingThisScene
                              ? "Pausar áudio"
                              : `Ouvir fala detectada (${formatTime(speechStart, true)} – ${formatTime(speechEnd, true)})`
                          }
                        >
                          {isPlayingThisScene ? (
                            <Pause className="size-3 text-primary animate-pulse" />
                          ) : (
                            <Play className="size-3 text-primary" />
                          )}
                          <span className={isPlayingThisScene ? "text-primary font-bold" : ""}>
                            {isPlayingThisScene ? "Ouvindo" : "Ouvir"}
                          </span>
                        </button>

                        {/* Botão de copiar texto */}
                        {sceneText && (
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard.writeText(sceneText);
                              toast.success(`Texto da Cena ${i + 1} copiado!`);
                            }}
                            className="hover:text-primary transition-colors text-muted-foreground pl-1 border-l border-border/60"
                            title="Copiar texto para prompt de IA"
                          >
                            <Copy className="size-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    {sceneText ? (
                      <p
                        onClick={() => {
                          void navigator.clipboard.writeText(sceneText);
                          toast.success(`Texto da Cena ${i + 1} copiado!`);
                        }}
                        className="text-[11px] leading-relaxed text-foreground/90 font-sans italic line-clamp-3 hover:line-clamp-none transition-all cursor-pointer hover:text-primary select-text"
                        title="Clique para copiar o texto desta cena"
                      >
                        "{sceneText}"
                      </p>
                    ) : (
                      <p className="text-[10px] italic text-muted-foreground/60 leading-tight">
                        {script.trim()
                          ? "(Ajustando trecho da fala...)"
                          : "(Insira o roteiro na Etapa 1 para visualizar a narração aqui)"}
                      </p>
                    )}
                  </div>

                  {/* Corpo da Mídia (Preview ou Slot de Encaixe) */}
                  {isFilled && img ? (
                    <div className="relative aspect-video w-full bg-black/40 overflow-hidden">
                      {img.kind === "video" ? (
                        <img
                          src={img.posterUrl}
                          alt={`Quadro de ${img.name}`}
                          className="size-full object-cover"
                        />
                      ) : (
                        <img src={img.url} alt={img.name} className="size-full object-cover" />
                      )}

                      {/* Badge do tipo */}
                      <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white backdrop-blur">
                        {img.kind === "video" ? "vídeo" : "imagem"}
                      </span>

                      {/* Botão de excluir */}
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          removeImage(img.id);
                          toast.success(
                            `Mídia removida da Cena ${i + 1}. A posição da cena foi mantida.`,
                          );
                        }}
                        className="absolute right-1.5 top-1.5 rounded-full bg-destructive/90 p-1 text-destructive-foreground opacity-100 shadow transition-opacity hover:bg-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        aria-label={`Remover ${img.name}`}
                        title="Remover mídia desta cena"
                      >
                        <X className="size-3" />
                      </button>

                      {/* Botão de trocar mídia do slot */}
                      <button
                        onClick={() => slotInputRefs.current[i]?.click()}
                        className="absolute left-1.5 top-1.5 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100 shadow backdrop-blur hover:bg-background"
                        title="Substituir mídia desta cena"
                      >
                        Trocar
                      </button>

                      {/* Botões de Mover Ordem */}
                      <div className="absolute inset-x-0 bottom-0 flex justify-between p-1 bg-gradient-to-t from-black/70 via-black/30 to-transparent opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          disabled={i === 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveImage(i, -1);
                          }}
                          className="rounded bg-background/80 p-0.5 text-foreground hover:bg-background disabled:opacity-30 disabled:pointer-events-none"
                          title="Mover para cena anterior"
                        >
                          <ChevronLeft className="size-3.5" />
                        </button>
                        <button
                          disabled={i === images.length - 1}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveImage(i, 1);
                          }}
                          className="rounded bg-background/80 p-0.5 text-foreground hover:bg-background disabled:opacity-30 disabled:pointer-events-none"
                          title="Mover para próxima cena"
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    // Slot Vazio Aguardando Encaixe
                    <div
                      onClick={() => {
                        if (canFillSlot) slotInputRefs.current[i]?.click();
                        else toast.info("Preencha as cenas anteriores primeiro.");
                      }}
                      className={`aspect-video w-full flex flex-col items-center justify-center p-3 text-center transition-colors ${
                        canFillSlot ? "cursor-pointer" : "cursor-not-allowed opacity-55"
                      }`}
                    >
                      <div className="size-8 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-1 group-hover:scale-110 transition-transform">
                        <Plus className="size-4" />
                      </div>
                      <span className="text-[11px] font-medium text-foreground">
                        {slot?.isPlaceholder
                          ? "Cena mantida — inserir nova mídia"
                          : canFillSlot
                            ? "Encaixar mídia aqui"
                            : "Preencha a cena anterior"}
                      </span>
                      <span className="text-[10px] text-muted-foreground mt-0.5">
                        Ficará em tela por {durationSec.toFixed(1)}s
                      </span>
                    </div>
                  )}

                  {/* Nome da mídia ou status */}
                  <div className="px-3 py-1.5 text-[10px] text-muted-foreground truncate bg-background/40 border-t border-border/20">
                    {isFilled && img ? (
                      <span title={img.name} className="truncate block font-mono">
                        {img.name}
                      </span>
                    ) : (
                      <span className="italic opacity-70">
                        {slot?.isPlaceholder
                          ? "Mídia removida — card preservado"
                          : "Aguardando mídia..."}
                      </span>
                    )}
                  </div>

                  {/* Input de arquivo invisível para seleção direta por slot */}
                  <input
                    ref={(el) => {
                      slotInputRefs.current[i] = el;
                    }}
                    type="file"
                    accept="image/*,video/*"
                    disabled={!canFillSlot}
                    className="hidden"
                    onChange={(e) => handleSlotFileChange(e, i)}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </StepCard>
  );
}
