import { Music4 } from "lucide-react";
import { StepCard } from "./StepCard";
import { FileDrop } from "./FileDrop";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { FileLoadIndicator } from "./FileLoadIndicator";

export function MusicStep() {
  const {
    music,
    loadAudio,
    musicVolume,
    setMusicVolume,
    narrationVolume,
    setNarrationVolume,
    duckOnly,
    setDuckOnly,
    fileLoadProgress,
  } = useVideoProject();

  return (
    <StepCard
      index={5}
      title="Música de fundo"
      description="Fica em loop sob a narração, com fade out no final."
      done={!!music}
    >
      <FileDrop accept="audio/*" onFiles={(files) => files[0] && loadAudio(files[0], "music")}>
        <Music4 className="size-6" />
        <span>{music ? music.name : "Arraste a trilha de fundo"}</span>
      </FileDrop>
      <FileLoadIndicator state={fileLoadProgress.music} />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Label className="text-xs text-muted-foreground">
            Volume da música: {duckOnly ? Math.min(musicVolume, 30) : musicVolume}%
          </Label>
          <Slider
            value={[musicVolume]}
            min={0}
            max={100}
            step={1}
            onValueChange={([v]) => setMusicVolume(v ?? 0)}
            className="mt-2"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">
            Volume da narração: {narrationVolume}%
          </Label>
          <Slider
            value={[narrationVolume]}
            min={0}
            max={100}
            step={1}
            onValueChange={([v]) => setNarrationVolume(v ?? 100)}
            className="mt-2"
          />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-secondary/40 p-3">
        <Switch id="duck" checked={duckOnly} onCheckedChange={setDuckOnly} />
        <Label htmlFor="duck" className="text-sm font-normal">
          Proteger a narração (limita a trilha a 30% do volume)
        </Label>
      </div>
    </StepCard>
  );
}
