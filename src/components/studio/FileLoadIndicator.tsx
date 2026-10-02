import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { FileLoadProgress } from "@/contexts/VideoProjectContext";

export function FileLoadIndicator({ state }: { state: FileLoadProgress }) {
  if (state.status === "idle") return null;

  const loading = state.status === "reading" || state.status === "processing";
  const failed = state.status === "error";

  return (
    <div
      className={`mt-3 rounded-lg border p-3 text-xs ${
        failed
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-secondary/40 text-muted-foreground"
      }`}
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {loading ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : failed ? (
          <AlertCircle className="size-3.5" />
        ) : (
          <CheckCircle2 className="size-3.5 text-primary" />
        )}
        <span className="flex-1">{state.message}</span>
        <span className="font-mono">{Math.round(state.progress)}%</span>
      </div>
      {loading && <Progress value={state.progress} className="mt-2 h-1.5" />}
    </div>
  );
}
