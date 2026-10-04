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
  validateVideoBlob,
  loadGoogleIdentityScript,
  requestGoogleAccessToken,
  type DriveUploadProgress,
  type DriveUploadResult,
} from "@/lib/drive/googleDrive";

interface GoogleDriveUploadProps {
  videoUrl: string;
  fileName: string;
  fileSize: number;
}

const DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const DOWNLOAD_CHUNK_TIMEOUT_MS = 120_000;

async function readExactBytes(
  response: Response,
  expectedBytes: number,
  onBytes: (count: number) => void,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes(bytes.byteLength);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    chunks.push(value);
    received += value.byteLength;
    onBytes(value.byteLength);
    if (received >= expectedBytes) {
      void reader.cancel();
      break;
    }
  }

  if (received !== expectedBytes) {
    throw new Error(`Transferência incompleta: recebidos ${received} de ${expectedBytes} bytes.`);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function downloadRenderedVideo(
  videoUrl: string,
  fileSize: number,
  cancelState: { cancelled: boolean; abort?: () => void },
  onProgress: (progress: DriveUploadProgress) => void,
): Promise<Blob> {
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error("O servidor não informou o tamanho válido do vídeo.");
  }

  const parts: BlobPart[] = [];
  let loaded = 0;
  let contentType = "video/mp4";

  while (loaded < fileSize) {
    if (cancelState.cancelled) throw new Error("Upload cancelado.");
    const rangeStart = loaded;
    const rangeEnd = Math.min(fileSize - 1, rangeStart + DOWNLOAD_CHUNK_SIZE - 1);
    const expectedBytes = rangeEnd - rangeStart + 1;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), DOWNLOAD_CHUNK_TIMEOUT_MS);
    cancelState.abort = () => controller.abort();

    try {
      const response = await fetch(videoUrl, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "video/mp4, video/webm, application/octet-stream",
          Range: `bytes=${rangeStart}-${rangeEnd}`,
        },
      });

      if (!response.ok) {
        let detail = "";
        try {
          const body = (await response.clone().json()) as { error?: string; message?: string };
          detail = body.error || body.message || "";
        } catch {
          detail = (await response.text()).slice(0, 300);
        }
        throw new Error(
          detail ||
            `O servidor não disponibilizou o vídeo (HTTP ${response.status}). Monte novamente.`,
        );
      }

      const responseType = (response.headers.get("content-type") || "").toLowerCase();
      if (
        responseType.includes("application/json") ||
        responseType.startsWith("text/") ||
        (!responseType.startsWith("video/") && !responseType.includes("application/octet-stream"))
      ) {
        throw new Error(
          `O servidor respondeu com ${responseType || "um tipo desconhecido"}, não com um vídeo.`,
        );
      }
      contentType = responseType || contentType;

      // Se algum proxy remover o Range, aceitamos somente o arquivo completo e exato.
      const bytesExpectedForResponse = response.status === 206 ? expectedBytes : fileSize;
      const bytes = await readExactBytes(response, bytesExpectedForResponse, (count) => {
        loaded += count;
        onProgress({
          percent: Math.min(100, Math.round((loaded / fileSize) * 100)),
          loadedBytes: loaded,
          totalBytes: fileSize,
        });
      });
      parts.push(bytes);

      if (response.status !== 206) break;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError" && !cancelState.cancelled) {
        throw new Error("Um bloco do vídeo excedeu 2 minutos durante a transferência.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const blob = new Blob(parts, { type: contentType });
  if (blob.size !== fileSize) {
    throw new Error(`O vídeo recebido está incompleto: ${blob.size} de ${fileSize} bytes.`);
  }
  return blob;
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
  const [transferStage, setTransferStage] = useState<"downloading" | "uploading">("downloading");

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

  useEffect(() => {
    if (clientId) void loadGoogleIdentityScript().catch(() => {});
  }, [clientId]);

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
    setTransferStage("downloading");
    setProgress({ percent: 0, loadedBytes: 0, totalBytes: fileSize });
    cancelRef.current = { cancelled: false };

    try {
      // Solicita autorização enquanto a ação ainda está ligada ao clique do usuário.
      const accessToken = await requestGoogleAccessToken(clientId);
      if (cancelRef.current.cancelled) throw new Error("Upload cancelado.");

      // 1. Busca o vídeo em blocos verificáveis. Isso evita conexões mantidas
      // abertas pelo proxy depois de 100% dos bytes já terem chegado.
      const blob = await downloadRenderedVideo(videoUrl, fileSize, cancelRef.current, setProgress);
      await validateVideoBlob(blob, fileName, fileSize);

      if (cancelRef.current.cancelled) {
        throw new Error("Upload cancelado.");
      }

      // 2. Realiza o upload para o Google Drive
      setTransferStage("uploading");
      setProgress({ percent: 0, loadedBytes: 0, totalBytes: blob.size });
      const result = await uploadVideoToGoogleDrive({
        blob,
        fileName,
        clientId,
        folderName: "Editor de Vídeo",
        onProgress: (p) => {
          setProgress(p);
        },
        cancelRef: cancelRef.current,
        accessToken,
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

  const handleCopyLink = async () => {
    if (!uploadResult?.webViewLink) return;
    const text = uploadResult.webViewLink;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Origens HTTP (ex.: IP da rede local) não expõem navigator.clipboard.
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const copiedLegacy = document.execCommand("copy");
        document.body.removeChild(area);
        if (!copiedLegacy) throw new Error("copy failed");
      }
    } catch {
      toast.error("Não foi possível copiar o link. Copie manualmente: " + text);
      return;
    }
    setCopied(true);
    toast.success("Link copiado para a área de transferência!");
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="mt-3 rounded-xl border border-border bg-card/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <HardDrive className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-foreground">
                Armazenamento no Google Drive
              </span>
              <span className="rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                100% Gratuito
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Economize espaço no servidor da aplicação salvando seus vídeos direto no Google Drive.
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
              className="gap-2 border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
            >
              <CloudUpload className="size-4" />
              {clientId ? "Salvar no Google Drive" : "Conectar Google Drive"}
            </Button>
          )}
        </div>
      </div>

      {/* Estado: Fazendo Upload */}
      {uploadStatus === "uploading" && (
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3.5">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="flex items-center gap-2 font-medium text-primary">
              <Loader2 className="size-3.5 animate-spin" />
              {transferStage === "downloading"
                ? `Preparando vídeo para envio (${progress.percent}%)`
                : `Enviando vídeo para o Google Drive (${progress.percent}%)`}
            </span>
            <span className="font-mono text-muted-foreground">
              {(progress.loadedBytes / 1024 / 1024).toFixed(1)} MB de{" "}
              {(progress.totalBytes / 1024 / 1024).toFixed(1)} MB
            </span>
          </div>

          <Progress value={progress.percent} />

          <div className="mt-2.5 flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              {transferStage === "downloading"
                ? "Transferindo o vídeo do servidor de renderização para o navegador."
                : 'Upload direto e resumível. O arquivo será salvo na pasta "Editor de Vídeo".'}
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
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-primary font-medium text-xs">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>
                Vídeo salvo na pasta <strong>"{uploadResult.folderName}"</strong> do seu Google
                Drive!
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyLink}
                className="gap-1.5 text-xs bg-background/50"
              >
                {copied ? (
                  <Check className="size-3.5 text-primary" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? "Copiado!" : "Copiar Link"}
              </Button>

              <Button size="sm" asChild className="gap-1.5 text-xs">
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
              <Cloud className="size-5 text-primary" />
              Conectar ao Google Drive
            </DialogTitle>
            <DialogDescription>
              Para conectar, crie ou selecione um projeto no Google Cloud Console e vincule um
              Client ID OAuth2. O processo pode ser feito gratuitamente.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            {/* Passo a passo rápido */}
            <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
              <p className="font-semibold text-foreground">
                Passo a passo no Google Cloud Console:
              </p>
              <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
                <li>
                  Crie um <strong>novo projeto</strong>, caso ainda não tenha um, ou selecione um
                  projeto existente no Google Cloud Console.
                </li>
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
                  Em <strong>Origens JavaScript autorizadas</strong>, adicione a origem onde esta
                  aplicação estiver sendo executada, exatamente como aparece na barra de endereço do
                  navegador.
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
