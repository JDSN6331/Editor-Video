import { useEffect, useState } from "react";
import { Clapperboard, Save, Loader2, Database } from "lucide-react";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { formatTime } from "@/lib/video/captions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProjectsModal } from "./ProjectsModal";
import { toast } from "sonner";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-display font-semibold">{value}</p>
    </div>
  );
}

export function StudioHeader() {
  const {
    duration,
    images,
    perImage,
    projectName,
    saveStatus,
    saveProjectToDb,
    dbType,
  } = useVideoProject();

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");

  useEffect(() => {
    if (saveDialogOpen) {
      setProjectNameInput(projectName === "Novo vídeo" ? "" : projectName);
    }
  }, [projectName, saveDialogOpen]);

  const handleManualSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = projectNameInput.trim();
    if (!name) return;

    const saved = await saveProjectToDb(name);
    if (saved) {
      setSaveDialogOpen(false);
      toast.success(`Projeto "${name}" salvo no banco de dados!`);
    }
  };

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-background/55 shadow-[0_10px_40px_-24px_oklch(0.72_0.19_45/0.35)] backdrop-blur-2xl">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
        {/* Logo and fixed application name */}
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
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Database className="size-3 text-primary" />
                {dbType === "postgres" ? "PostgreSQL (Prod)" : "SQLite (Local)"}
              </span>
              <span>•</span>
              {saveStatus === "saving" ? (
                <span className="flex items-center gap-1 text-amber-500">
                  <Loader2 className="size-3 animate-spin" />
                  Salvando...
                </span>
              ) : (
                <span className="text-muted-foreground/80">Salvamento manual</span>
              )}
            </div>
          </div>
        </div>

        {/* Project Actions & Statistics */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <ProjectsModal />
            <Button
              variant="default"
              size="sm"
              onClick={() => setSaveDialogOpen(true)}
              disabled={saveStatus === "saving"}
              className="gap-1.5"
            >
              <Save className="size-3.5" />
              <span>Salvar</span>
            </Button>
          </div>

          <div className="hidden sm:flex items-center gap-5 border-l border-border pl-4 text-sm">
            <Stat label="Duração" value={duration ? formatTime(duration) : "—"} />
            <Stat label="Imagens" value={images.length ? String(images.length) : "—"} />
            <Stat
              label="Tempo por imagem"
              value={perImage ? `${perImage.toFixed(3).replace(".", ",")}s` : "—"}
            />
          </div>
        </div>
      </div>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleManualSave}>
            <DialogHeader>
              <DialogTitle>Salvar projeto</DialogTitle>
              <DialogDescription>
                Escolha um nome para identificar este projeto na sua biblioteca.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 py-5">
              <Label htmlFor="project-name">Nome do projeto</Label>
              <Input
                id="project-name"
                value={projectNameInput}
                onChange={(event) => setProjectNameInput(event.target.value)}
                placeholder="Ex.: Vídeo sobre educação financeira"
                autoFocus
                maxLength={120}
              />
              {!projectNameInput.trim() && (
                <p className="text-xs text-muted-foreground">
                  Digite um nome para habilitar o salvamento.
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setSaveDialogOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={!projectNameInput.trim() || saveStatus === "saving"}>
                {saveStatus === "saving" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Salvar projeto
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
}
