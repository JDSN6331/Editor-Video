import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepCardProps {
  index: number;
  title: string;
  description: string;
  done?: boolean;
  children: ReactNode;
  aside?: ReactNode;
}

export function StepCard({ index, title, description, done, children, aside }: StepCardProps) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border bg-card p-5 transition-colors sm:p-6",
        done && "border-primary/40",
      )}
      style={{ boxShadow: "var(--shadow-panel)" }}
    >
      <header className="mb-4 flex items-start gap-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border font-display text-sm font-semibold",
            done ? "border-transparent bg-primary text-primary-foreground" : "bg-secondary",
          )}
        >
          {done ? <Check className="size-4" /> : index}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}
