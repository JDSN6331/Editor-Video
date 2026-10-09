import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { StepCard } from "./StepCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVideoProject, ACCENTS } from "@/contexts/VideoProjectContext";
import { drawThumbnail } from "@/lib/video/thumbnail";
import { downloadBlob } from "@/lib/utils";
import { toast } from "sonner";

type NativeSaveFileHandle = {
  createWritable: () => Promise<{
    write: (data: ArrayBuffer) => Promise<void>;
    close: () => Promise<void>;
  }>;
  getFile: () => Promise<File>;
};

type NativeSavePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<NativeSaveFileHandle>;

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
  const [isDownloading, setIsDownloading] = useState(false);

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

  const handleDownload = async () => {
    const image = images[thumbIndex];
    if (!image || isDownloading) return;
    setIsDownloading(true);
    try {
      // Toda a geração acontece sincronamente dentro do clique. Quando a caixa
      // "Salvar como" abrir, os bytes do PNG já estarão completos e validados.
      const exportCanvas = document.createElement("canvas");
      drawThumbnail(exportCanvas, {
        image: image.element,
        title: thumbTitle,
        subtitle: thumbSubtitle,
        accent,
      });
      const dataUrl = exportCanvas.toDataURL("image/png");
      const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const isPng =
        bytes.length > 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a;
      if (!isPng) throw new Error("A thumbnail gerada não contém um PNG válido.");

      const pngBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const nativeSavePicker = (window as Window & { showSaveFilePicker?: NativeSavePicker })
        .showSaveFilePicker;

      if (nativeSavePicker) {
        const fileHandle = await nativeSavePicker.call(window, {
          suggestedName: "thumbnail.png",
          types: [
            {
              description: "Imagem PNG",
              accept: { "image/png": [".png"] },
            },
          ],
        });
        const writable = await fileHandle.createWritable();
        await writable.write(pngBuffer);
        await writable.close();

        const savedFile = await fileHandle.getFile();
        if (savedFile.size !== bytes.byteLength) {
          throw new Error(
            `O arquivo salvo ficou incompleto: ${savedFile.size} de ${bytes.byteLength} bytes.`,
          );
        }
        toast.success("Thumbnail salva em PNG.");
      } else {
        downloadBlob(new Blob([pngBuffer], { type: "image/png" }), "thumbnail.png");
        toast.success("Thumbnail baixada em PNG.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        toast.info("Salvamento da thumbnail cancelado.");
        return;
      }
      console.error("Falha ao gerar thumbnail para download.", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Não foi possível gerar o PNG da thumbnail. Tente novamente.",
      );
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <StepCard
      index={7}
      title="Thumbnail"
      description="1280×720 com a legenda em destaque, pronta para subir junto do vídeo."
      done={!!images.length && !!thumbTitle}
    >
      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Carregue uma imagem ou vídeo para criar a capa.
        </p>
      ) : (
        <div className="space-y-4">
          <canvas ref={canvasRef} className="w-full rounded-xl border border-border bg-black" />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <Label className="whitespace-nowrap text-xs text-muted-foreground">Título</Label>
              <Input
                value={thumbTitle}
                onChange={(e) => setThumbTitle(e.target.value)}
                placeholder="Digite o título da thumbnail"
                className="mt-1 bg-secondary/40"
              />
            </div>
            <div className="min-w-0">
              <Label className="whitespace-nowrap text-xs text-muted-foreground">
                Chamada (opcional)
              </Label>
              <Input
                value={thumbSubtitle}
                onChange={(e) => setThumbSubtitle(e.target.value)}
                className="mt-1 bg-secondary/40"
              />
            </div>
          </div>
          <div className="flex flex-col gap-3">
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
            </div>
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-2 shrink-0 text-xs text-muted-foreground">Imagem:</span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {images.map((img, i) => (
                  <button
                    type="button"
                    key={img.id}
                    onClick={() => setThumbIndex(i)}
                    aria-label={`Selecionar imagem ${i + 1}`}
                    aria-pressed={thumbIndex === i}
                    className="overflow-hidden rounded border-2"
                    style={{
                      borderColor: thumbIndex === i ? accent : "transparent",
                    }}
                  >
                    <img
                      src={img.kind === "video" ? img.posterUrl : img.url}
                      alt=""
                      className="h-8 w-14 object-cover"
                    />
                  </button>
                ))}
              </div>
            </div>
            {thumbnailReady ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="self-end"
                onClick={handleDownload}
                disabled={isDownloading}
              >
                <Download className="size-4" />
                {isDownloading ? "Gerando PNG..." : "Baixar thumbnail"}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="secondary" className="self-end" disabled>
                <Download className="size-4" /> Preparando thumbnail...
              </Button>
            )}
          </div>
        </div>
      )}
    </StepCard>
  );
}
