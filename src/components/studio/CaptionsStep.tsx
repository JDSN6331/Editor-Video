import { Subtitles } from "lucide-react";
import { StepCard } from "./StepCard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime, toSRT } from "@/lib/video/captions";
import { downloadBlob } from "@/lib/utils";

export function CaptionsStep() {
  const { captions, showCaptions, setShowCaptions, maxChars, setMaxChars } = useVideoProject();

  return (
    <StepCard
      index={4}
      title="Legendas"
      description="Geradas a partir do roteiro e distribuídas ao longo da narração."
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
      {captions.length > 0 ? (
        <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-secondary/30 p-2 text-sm">
          {captions.map((c, i) => (
            <li key={i} className="flex gap-3 rounded px-2 py-1 hover:bg-secondary">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {formatTime(c.start)}
              </span>
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Carregue o roteiro e a narração para gerar as legendas.
        </p>
      )}
    </StepCard>
  );
}
