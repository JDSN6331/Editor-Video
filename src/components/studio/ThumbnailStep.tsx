import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { StepCard } from "./StepCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVideoProject, ACCENTS } from "@/contexts/VideoProjectContext";
import { drawThumbnail } from "@/lib/video/thumbnail";

export function ThumbnailStep() {
  const {
    images,
    thumbIndex,
    setThumbIndex,
    thumbTitle,
    setThumbTitle,
    thumbSubtitle,
    setThumbSubtitle,
    accent,
    setAccent,
  } = useVideoProject();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [thumbnailReady, setThumbnailReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = images[thumbIndex];
    if (!canvas || !img) return;
    drawThumbnail(canvas, {
      image: img.element,
      title: thumbTitle,
      subtitle: thumbSubtitle,
      accent,
    });

    setThumbnailReady(true);
  }, [images, thumbIndex, thumbTitle, thumbSubtitle, accent]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "thumbnail.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  return (
    <StepCard
      index={7}
      title="Thumbnail"
      description="1280×720 com a legenda em destaque, pronta para subir junto do vídeo."
      done={!!images.length && !!thumbTitle}
    >
      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground">Carregue imagens para criar a capa.</p>
      ) : (
        <div className="space-y-4">
          <canvas ref={canvasRef} className="w-full rounded-xl border border-border bg-black" />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">Título</Label>
              <Input
                value={thumbTitle}
                onChange={(e) => setThumbTitle(e.target.value)}
                placeholder="Digite o título da thumbnail"
                className="mt-1 bg-secondary/40"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Chamada (opcional)</Label>
              <Input
                value={thumbSubtitle}
                onChange={(e) => setThumbSubtitle(e.target.value)}
                className="mt-1 bg-secondary/40"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">Cor:</span>
            {ACCENTS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setAccent(c)}
                aria-label={`Cor ${c}`}
                className="size-6 rounded-full border-2"
                style={{
                  background: c,
                  borderColor: accent === c ? "#fff" : "transparent",
                }}
              />
            ))}
            <span className="ml-3 text-xs text-muted-foreground">Imagem:</span>
            <div className="flex gap-1">
              {images.slice(0, 8).map((img, i) => (
                <button
                  type="button"
                  key={img.id}
                  onClick={() => setThumbIndex(i)}
                  className="overflow-hidden rounded border-2"
                  style={{
                    borderColor: thumbIndex === i ? accent : "transparent",
                  }}
                >
                  <img src={img.url} alt="" className="h-8 w-14 object-cover" />
                </button>
              ))}
            </div>
            {thumbnailReady ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="ml-auto"
                onClick={handleDownload}
              >
                <Download className="size-4" /> Baixar thumbnail
              </Button>
            ) : (
              <Button type="button" size="sm" variant="secondary" className="ml-auto" disabled>
                <Download className="size-4" /> Preparando thumbnail...
              </Button>
            )}
          </div>
        </div>
      )}
    </StepCard>
  );
}
