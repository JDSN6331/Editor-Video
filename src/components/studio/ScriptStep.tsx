import { useRef } from "react";
import { FileText } from "lucide-react";
import { StepCard } from "./StepCard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useVideoProject } from "@/contexts/VideoProjectContext";
import { FileLoadIndicator } from "./FileLoadIndicator";

export function ScriptStep() {
  const { script, setScript, loadScriptFile, fileLoadProgress } = useVideoProject();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <StepCard
      index={1}
      title="Roteiro"
      description="Cole o texto que virá da sua etapa externa ou envie um arquivo .txt."
      done={script.trim().length > 0}
    >
      <Textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        placeholder="Cole aqui o roteiro narrado…"
        className="min-h-40 resize-y bg-secondary/40"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
          <FileText className="size-4" /> Carregar .txt
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,text/plain"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await loadScriptFile(file);
            e.target.value = "";
          }}
        />
        <span>{script.trim() ? `${script.trim().split(/\s+/).length} palavras` : "vazio"}</span>
      </div>
      <FileLoadIndicator state={fileLoadProgress.script} />
    </StepCard>
  );
}
