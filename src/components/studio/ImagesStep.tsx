import { useState } from "react";
import {
  Image as ImageIcon,
  Film,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from "lucide-react";
import { StepCard } from "./StepCard";
import { FileDrop } from "./FileDrop";
import { Button } from "@/components/ui/button";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { FileLoadIndicator } from "./FileLoadIndicator";

export function ImagesStep() {
  const {
    images,
    setImages,
    addImages,
    removeImage,
    moveImage,
    reorderImages,
    perImage,
    fileLoadProgress,
  } = useVideoProject();

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

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

  return (
    <StepCard
      index={2}
      title="Imagens e vídeos"
      description="Use imagens, vídeos ou os dois. Arraste para definir a sequência da montagem."
      done={images.length > 0}
      aside={
        images.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setImages([])}>
            <Trash2 className="size-4" /> limpar todas
          </Button>
        ) : undefined
      }
    >
      <FileDrop accept="image/*,video/*" multiple onFiles={addImages}>
        <div className="flex items-center gap-1 text-primary">
          <ImageIcon className="size-6" />
          <Film className="size-6" />
        </div>
        <span>Arraste imagens ou vídeos, ou clique para selecionar</span>
      </FileDrop>
      <FileLoadIndicator state={fileLoadProgress.images} />

      {images.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-muted-foreground">
            Dica: arraste os cartões para reposicionar ou use os botões ◀ ▶.
          </p>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {images.map((img, i) => (
              <li
                key={img.id}
                draggable
                onDragStart={(e) => handleDragStart(e, i)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, i)}
                onDragEnd={() => setDraggedIndex(null)}
                className={`group relative overflow-hidden rounded-xl border transition-all select-none ${
                  draggedIndex === i
                    ? "opacity-40 scale-95 border-primary border-dashed"
                    : "border-border bg-card/60 hover:border-primary/50 hover:shadow-md"
                }`}
              >
                {img.kind === "video" ? (
                  <video
                    src={img.url}
                    className="aspect-video w-full object-cover"
                    muted
                    preload="metadata"
                  />
                ) : (
                  <img src={img.url} alt={img.name} className="aspect-video w-full object-cover" />
                )}
                <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white">
                  {img.kind === "video" ? "vídeo" : "imagem"}
                </span>

                {/* Index badge */}
                <span className="absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded bg-background/85 px-1.5 py-0.5 text-[11px] font-semibold backdrop-blur shadow-sm">
                  <GripVertical className="size-2.5 text-muted-foreground opacity-60" />
                  {i + 1}
                </span>

                {/* Duration badge */}
                {perImage > 0 && (
                  <span className="absolute bottom-1.5 left-1.5 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-mono backdrop-blur shadow-sm">
                    {perImage.toFixed(1)}s
                  </span>
                )}

                {/* Remove button */}
                <button
                  onClick={() => removeImage(img.id)}
                  className="absolute right-1.5 top-1.5 rounded-full bg-destructive/90 p-1 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100 shadow"
                  aria-label={`Remover ${img.name}`}
                  title="Remover mídia"
                >
                  <X className="size-3" />
                </button>

                {/* Move buttons */}
                <div className="absolute inset-x-0 bottom-0 flex justify-between p-1 bg-gradient-to-t from-black/70 via-black/30 to-transparent opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveImage(i, -1);
                    }}
                    className="rounded bg-background/80 p-0.5 text-foreground hover:bg-background disabled:opacity-30 disabled:pointer-events-none"
                    title="Mover para esquerda"
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
                    title="Mover para direita"
                  >
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </StepCard>
  );
}
