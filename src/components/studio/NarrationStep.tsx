import { AudioLines } from "lucide-react";
import { StepCard } from "./StepCard";
import { FileDrop } from "./FileDrop";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { FileLoadIndicator } from "./FileLoadIndicator";

export function NarrationStep() {
  const { narration, loadAudio, duration, images, perImage, fileLoadProgress } = useVideoProject();

  return (
    <StepCard
      index={3}
      title="Narração"
      description="A duração da narração define a duração do vídeo e o tempo de cada imagem."
      done={!!narration}
    >
      <FileDrop accept="audio/*" onFiles={(files) => files[0] && loadAudio(files[0], "narration")}>
        <AudioLines className="size-6" />
        <span>{narration ? narration.name : "Arraste o áudio da narração (mp3, wav, m4a)"}</span>
      </FileDrop>
      <FileLoadIndicator state={fileLoadProgress.narration} />
      {narration && (
        <div className="mt-4 space-y-3">
          <audio controls src={narration.url} className="w-full" />
          <div className="rounded-lg border border-border bg-secondary/40 p-3 text-sm">
            <p>
              Narração de <strong>{formatTime(duration, true)}</strong>
              {images.length > 0 && (
                <>
                  {" "}
                  ÷ {images.length} imagens ={" "}
                  <strong>{perImage.toFixed(3).replace(".", ",")} s</strong> por imagem
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </StepCard>
  );
}
