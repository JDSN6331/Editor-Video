import { Clapperboard, Cloud } from "lucide-react";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { isFilledMedia } from "@/lib/video/types";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-display font-semibold">{value}</p>
    </div>
  );
}

export function StudioHeader() {
  const { duration, images, perImage } = useVideoProject();
  const filledMediaCount = images.filter(isFilledMedia).length;

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-background/55 shadow-[0_10px_40px_-24px_oklch(0.72_0.19_45/0.35)] backdrop-blur-2xl">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-4 px-5 py-4">
        {/* Logo e identificação do estúdio */}
        <div className="flex items-center gap-3">
          <span
            className="flex size-10 items-center justify-center rounded-xl border border-white/20 shadow-[var(--shadow-glow)]"
            style={{ background: "var(--gradient-studio)" }}
          >
            <Clapperboard className="size-5 text-primary-foreground" />
          </span>

          <div className="flex flex-col gap-0.5">
            <h1 className="font-display text-lg font-bold tracking-tight sm:text-xl">
              Estúdio de Criação de Vídeo
            </h1>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Cloud className="size-3.5 text-primary" />
              <span>Upload direto no Google Drive</span>
              <span>•</span>
              <span className="text-muted-foreground/80">Otimizado para o YouTube</span>
            </div>
          </div>
        </div>

        {/* Estatísticas do Vídeo em Tempo Real */}
        <div className="flex items-center gap-5 text-sm">
          <Stat label="Duração" value={duration ? formatTime(duration) : "—"} />
          <Stat label="Imagens" value={filledMediaCount ? String(filledMediaCount) : "—"} />
          <Stat
            label="Média por cena"
            value={perImage ? `${perImage.toFixed(3).replace(".", ",")}s` : "—"}
          />
        </div>
      </div>
    </header>
  );
}
