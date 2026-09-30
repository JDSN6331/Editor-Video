import { useEffect, useState } from "react";
import {
  FolderOpen,
  Plus,
  Trash2,
  Calendar,
  Image as ImageIcon,
  Mic,
  Database,
  CheckCircle2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { listProjectsFn, deleteProjectFn } from "@/api/projects";
import type { ProjectSummary } from "@/db";
import { toast } from "sonner";

export function ProjectsModal() {
  const { projectId, loadProjectFromDb, createNewProject, dbType } = useVideoProject();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const list = await listProjectsFn();
      setProjects(list);
    } catch (e) {
      console.error("Falha ao carregar lista de projetos:", e);
      toast.error("Não foi possível listar os projetos.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchProjects();
    }
  }, [open]);

  const handleOpenProject = async (id: string) => {
    await loadProjectFromDb(id);
    setOpen(false);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Tem certeza que deseja excluir o projeto "${name}"?`)) return;
    try {
      await deleteProjectFn({ data: id });
      toast.success("Projeto excluído.");
      fetchProjects();
      if (id === projectId) {
        createNewProject();
      }
    } catch (e) {
      console.error(e);
      toast.error("Erro ao excluir projeto.");
    }
  };

  const handleNewProject = () => {
    createNewProject();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <FolderOpen className="size-4 text-primary" />
          <span>Meus Projetos</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle className="flex items-center gap-2 font-display text-lg">
              <FolderOpen className="size-5 text-primary" />
              Projetos Salvos
              <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-xs text-muted-foreground font-normal">
                <Database className="size-3 text-primary" />
                {dbType === "postgres" ? "PostgreSQL" : "SQLite"}
              </span>
            </DialogTitle>
            <Button size="sm" onClick={handleNewProject} className="gap-1.5">
              <Plus className="size-3.5" /> Novo Projeto
            </Button>
          </div>
        </DialogHeader>

        <div className="mt-4 max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Carregando projetos do banco de dados...
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-12 text-center">
              <FolderOpen className="mx-auto size-8 text-muted-foreground/60" />
              <p className="mt-2 text-sm font-medium">Nenhum projeto salvo ainda</p>
              <p className="text-xs text-muted-foreground">
                Clique em Salvar e escolha um nome quando quiser guardar um projeto.
              </p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={handleNewProject}>
                Criar Primeiro Projeto
              </Button>
            </div>
          ) : (
            projects.map((proj) => {
              const isCurrent = proj.id === projectId;
              const date = new Date(proj.updatedAt).toLocaleString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });

              return (
                <div
                  key={proj.id}
                  className={`group flex items-center justify-between rounded-xl border p-3.5 transition-all ${
                    isCurrent
                      ? "border-primary/50 bg-primary/5"
                      : "border-border bg-card/40 hover:border-border/80 hover:bg-card"
                  }`}
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">
                        {proj.name || "Projeto sem título"}
                      </span>
                      {isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                          <CheckCircle2 className="size-3" /> Atual
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Calendar className="size-3" />
                        {date}
                      </span>
                      <span className="flex items-center gap-1">
                        <ImageIcon className="size-3" />
                        {proj.imageCount} img
                      </span>
                      {proj.hasNarration && (
                        <span className="flex items-center gap-1 text-primary">
                          <Mic className="size-3" /> Narração
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={isCurrent ? "secondary" : "default"}
                      onClick={() => handleOpenProject(proj.id)}
                    >
                      {isCurrent ? "Recarregar" : "Abrir"}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(proj.id, proj.name)}
                      title="Excluir projeto"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
