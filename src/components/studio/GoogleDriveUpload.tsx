import { useState, useRef, useEffect } from "react";
import {
  Cloud,
  CloudUpload,
  CheckCircle2,
  ExternalLink,
  Copy,
  Check,
  Settings,
  AlertCircle,
  Loader2,
  X,
  HardDrive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  getStoredGoogleClientId,
  saveGoogleClientId,
  uploadVideoToGoogleDrive,
  clearGoogleAuthCache,
  type DriveUploadProgress,
  type DriveUploadResult,
} from "@/lib/drive/googleDrive";

interface GoogleDriveUploadProps {
  videoUrl: string;
  fileName: string;
  fileSize: number;
}

export function GoogleDriveUpload({ videoUrl, fileName, fileSize }: GoogleDriveUploadProps) {
  const [clientId, setClientId] = useState("");
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [inputClientId, setInputClientId] = useState("");
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "success" | "error">(
    "idle",
  );
  const [progress, setProgress] = useState<DriveUploadProgress>({
    percent: 0,
    loadedBytes: 0,
    totalBytes: fileSize,
  });
  const [uploadResult, setUploadResult] = useState<DriveUploadResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const cancelRef = useRef<{ cancelled: boolean; abort?: () => void }>({
    cancelled: false,
  });

  // Carrega o Client ID salvo no localStorage
  useEffect(() => {
    const saved = getStoredGoogleClientId();
    if (saved) {
      setClientId(saved);
      setInputClientId(saved);
    }
  }, []);

  const handleSaveConfig = () => {
    const clean = inputClientId.trim();
    if (!clean) {
      toast.error("Por favor, informe o Client ID do Google Cloud.");
      return;
    }
    if (!clean.includes(".apps.googleusercontent.com")) {
      toast.warning(
        "Atenção: O Client ID do Google geralmente termina com '.apps.googleusercontent.com'.",
      );
    }
    saveGoogleClientId(clean);
    setClientId(clean);
    setIsConfigOpen(false);
    toast.success("Client ID do Google Drive salvo!");
  };

  const handleStartUpload = async () => {
    if (!clientId) {
      setIsConfigOpen(true);
      return;
    }

    setUploadStatus("uploading");
    setErrorMessage(null);
    setProgress({ percent: 0, loadedBytes: 0, totalBytes: fileSize });
    cancelRef.current = { cancelled: false };

    try {
      // 1. Busca o blob gerado do vídeo local
      const res = await fetch(videoUrl);
      const blob = await res.blob();

      // 2. Realiza o upload para o Google Drive
      const result = await uploadVideoToGoogleDrive({
        blob,
        fileName,
        clientId,
        folderName: "Editor de Vídeo",
        onProgress: (p) => {
          setProgress(p);
        },
        cancelRef: cancelRef.current,
      });

      setUploadResult(result);
      setUploadStatus("success");
      toast.success("Vídeo enviado com sucesso para o Google Drive!");
    } catch (err) {
      if (cancelRef.current.cancelled) {
        setUploadStatus("idle");
        toast.info("Upload cancelado.");
        return;
      }
      const msg = err instanceof Error ? err.message : "Falha ao enviar para o Google Drive.";
      setErrorMessage(msg);
      setUploadStatus("error");
      toast.error(`Erro no Google Drive: ${msg}`);
    }
  };

  const handleCancelUpload = () => {
    cancelRef.current.cancelled = true;
    if (cancelRef.current.abort) {
      cancelRef.current.abort();
    }
    setUploadStatus("idle");
  };

  const handleCopyLink = () => {
    if (!uploadResult?.webViewLink) return;
    navigator.clipboard.writeText(uploadResult.webViewLink);
    setCopied(true);
    toast.success("Link copiado para a área de transferência!");
    setTimeout(() => setCopied(false), 2500);
  };

  const currentOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:5173";

  return (
    <div className="mt-3 rounded-xl border border-border bg-card/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
            <HardDrive className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-foreground">
                Armazenamento no Google Drive
              </span>
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/30">
                100% Gratuito
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Economize espaço na Hostinger salvando seus vídeos direto no seu Google Drive.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {clientId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsConfigOpen(true)}
              className="text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              title="Configurações do Google Cloud"
            >
              <Settings className="size-3.5" />
              Configurações
            </Button>
          )}

          {uploadStatus === "idle" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartUpload}
              className="gap-2 border-sky-500/30 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20"
            >
              <CloudUpload className="size-4" />
              {clientId ? "Salvar no Google Drive" : "Conectar Google Drive"}
            </Button>
          )}
        </div>
      </div>

      {/* Estado: Fazendo Upload */}
      {uploadStatus === "uploading" && (
        <div className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3.5">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="flex items-center gap-2 font-medium text-sky-400">
              <Loader2 className="size-3.5 animate-spin" />
              Enviando vídeo para o Google Drive ({progress.percent}%)
            </span>
            <span className="font-mono text-muted-foreground">
              {(progress.loadedBytes / 1024 / 1024).toFixed(1)} MB de{" "}
              {(progress.totalBytes / 1024 / 1024).toFixed(1)} MB
            </span>
          </div>

          <Progress value={progress.percent} />

          <div className="mt-2.5 flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              Upload direto e resumível. O arquivo será salvo na pasta "Editor de Vídeo".
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancelUpload}
              className="h-7 text-xs text-destructive hover:bg-destructive/10"
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {/* Estado: Sucesso */}
      {uploadStatus === "success" && uploadResult && (
        <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-emerald-400 font-medium text-xs">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>
                Vídeo salvo na pasta <strong>"{uploadResult.folderName}"</strong> do seu Google Drive!
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyLink}
                className="gap-1.5 text-xs bg-background/50"
              >
                {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                {copied ? "Copiado!" : "Copiar Link"}
              </Button>

              <Button
                size="sm"
                asChild
                className="gap-1.5 text-xs bg-emerald-500 text-white hover:bg-emerald-600"
              >
                <a href={uploadResult.webViewLink} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-3.5" />
                  Abrir no Google Drive
                </a>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Estado: Erro */}
      {uploadStatus === "error" && errorMessage && (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3.5 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 text-destructive">
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Erro ao enviar para o Google Drive:</span>
                <p className="mt-0.5 text-destructive/90">{errorMessage}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartUpload}
              className="h-7 text-xs shrink-0"
            >
              Tentar novamente
            </Button>
          </div>
        </div>
      )}

      {/* Modal de Configuração do Google Cloud Client ID */}
      <Dialog open={isConfigOpen} onOpenChange={setIsConfigOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cloud className="size-5 text-sky-400" />
              Conectar ao Google Drive
            </DialogTitle>
            <DialogDescription>
              Como você já possui um projeto no Google Cloud Console, basta vincular seu Client ID
              OAuth2. O processo é 100% gratuito.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            {/* Passo a passo rápido */}
            <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
              <p className="font-semibold text-foreground">Passo a passo no Google Cloud Console:</p>
              <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
                <li>
                  Acesse o{" "}
                  <a
                    href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline inline-flex items-center gap-0.5"
                  >
                    Google Drive API <ExternalLink className="size-3" />
                  </a>{" "}
                  e clique em <strong>Ativar</strong> no seu projeto.
                </li>
                <li>
                  Vá em <strong>APIs e Serviços &gt; Credenciais</strong> e clique em{" "}
                  <strong>Criar Credenciais &gt; ID do cliente OAuth</strong>.
                </li>
                <li>
                  Selecione o tipo: <strong>Aplicativo da Web</strong>.
                </li>
                <li>
                  Em <strong>Origens JavaScript autorizadas</strong>, adicione:
                  <div className="mt-1 flex items-center gap-1.5 rounded bg-background p-1.5 font-mono text-[11px] text-primary">
                    <span className="flex-1 select-all">{currentOrigin}</span>
                  </div>
                </li>
                <li>
                  Copie o <strong>ID do Cliente</strong> gerado e cole abaixo.
                </li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="client-id" className="text-xs">
                Client ID OAuth2 do Google Cloud
              </Label>
              <Input
                id="client-id"
                placeholder="ex: 123456789-abcdef.apps.googleusercontent.com"
                value={inputClientId}
                onChange={(e) => setInputClientId(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                O Client ID fica salvo no seu navegador e é usado para abrir o pop-up oficial do
                Google solicitando permissão apenas para a pasta do editor.
              </p>
            </div>
          </div>

          <div className="flex justify-between items-center pt-2">
            {clientId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearGoogleAuthCache();
                  saveGoogleClientId("");
                  setClientId("");
                  setInputClientId("");
                  setIsConfigOpen(false);
                  toast.info("Conexão com o Google Drive desvinculada.");
                }}
                className="text-xs text-destructive hover:bg-destructive/10"
              >
                Desconectar
              </Button>
            )}
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" size="sm" onClick={() => setIsConfigOpen(false)}>
                Cancelar
              </Button>
              <Button size="sm" onClick={handleSaveConfig}>
                Salvar Client ID
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
