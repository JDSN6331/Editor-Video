import { Film, CheckCircle2 } from "lucide-react";

export function AboutSidebar() {
  return (
    <div className="glass-panel rounded-2xl border p-5 text-sm text-muted-foreground">
      <h2 className="mb-2 flex items-center gap-2 font-display text-base font-semibold text-foreground">
        <Film className="size-4 text-primary" /> Recursos do Estúdio
      </h2>
      <ul className="space-y-2.5 text-xs">
        <li className="flex items-start gap-2">
          <CheckCircle2 className="size-3.5 text-primary shrink-0 mt-0.5" />
          <span>
            <strong>Exportação MP4 Direta:</strong> saída em MP4 de alta performance otimizado para
            o YouTube.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="size-3.5 text-primary shrink-0 mt-0.5" />
          <span>
            <strong>Nuvem Google Drive:</strong> envio direto e automatizado para o Google Drive sem
            ocupar espaço na Hostinger.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="size-3.5 text-primary shrink-0 mt-0.5" />
          <span>
            <strong>Sincronia Inteligente de Legendas:</strong> detecção de pausas de fala (VAD)
            para legendas sem atraso.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="size-3.5 text-primary shrink-0 mt-0.5" />
          <span>
            <strong>Reordenação de Imagens:</strong> drag-and-drop nativo ou botões de ordenação
            rápida.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CheckCircle2 className="size-3.5 text-primary shrink-0 mt-0.5" />
          <span>
            <strong>Linha do Tempo Interativa:</strong> navegação temporal por scrubbing e preview
            de quadros.
          </span>
        </li>
      </ul>
    </div>
  );
}
