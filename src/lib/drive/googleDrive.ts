/**
 * Utilitários para integração com o Google Drive via Google Identity Services (GIS)
 * e Google Drive API v3 (Resumable Upload).
 *
 * Escopo utilizado: https://www.googleapis.com/auth/drive.file
 * - Acessa APENAS arquivos e pastas criados por este aplicativo.
 * - Não tem acesso a outros arquivos pessoais do usuário no Google Drive.
 */

const STORAGE_KEY_CLIENT_ID = "editor_video_gdrive_client_id";
const SCRIPT_URL = "https://accounts.google.com/gsi/client";
const DEFAULT_FOLDER_NAME = "Editor de Vídeo";

export interface DriveUploadProgress {
  percent: number;
  loadedBytes: number;
  totalBytes: number;
}

export interface DriveUploadResult {
  fileId: string;
  name: string;
  webViewLink: string;
  folderName: string;
  size: number;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: {
              access_token?: string;
              error?: string;
              error_description?: string;
              expires_in?: number;
            }) => void;
            error_callback?: (err: { message?: string }) => void;
          }) => {
            requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
          };
        };
      };
    };
  }
}

// Cache em memória do token de acesso durante a sessão
let cachedToken: { token: string; expiresAt: number } | null = null;

export function getStoredGoogleClientId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY_CLIENT_ID) || "";
}

export function saveGoogleClientId(clientId: string): void {
  if (typeof window === "undefined") return;
  const cleanId = clientId.trim();
  if (cleanId) {
    localStorage.setItem(STORAGE_KEY_CLIENT_ID, cleanId);
  } else {
    localStorage.removeItem(STORAGE_KEY_CLIENT_ID);
  }
}

export function clearGoogleAuthCache(): void {
  cachedToken = null;
}

/**
 * Carrega a biblioteca Google Identity Services de forma assíncrona
 */
export function loadGoogleIdentityScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve();
    if (window.google?.accounts?.oauth2) return resolve();

    const existingScript = document.getElementById("google-gsi-script");
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve());
      existingScript.addEventListener("error", () =>
        reject(new Error("Falha ao carregar script do Google Identity Services.")),
      );
      return;
    }

    const script = document.createElement("script");
    script.id = "google-gsi-script";
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          "Não foi possível conectar aos servidores do Google. Verifique sua conexão com a internet.",
        ),
      );
    document.head.appendChild(script);
  });
}

/**
 * Solicita autorização OAuth2 ao usuário e obtém o token de acesso
 */
export async function requestGoogleAccessToken(
  clientId: string,
  forcePrompt = false,
): Promise<string> {
  if (!clientId || !clientId.trim()) {
    throw new Error("Client ID do Google Cloud não configurado.");
  }

  // Se já temos um token válido e não expirado
  if (!forcePrompt && cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.token;
  }

  await loadGoogleIdentityScript();

  if (!window.google?.accounts?.oauth2) {
    throw new Error("Biblioteca do Google Identity Services não disponível.");
  }

  return new Promise((resolve, reject) => {
    try {
      const client = window.google!.accounts.oauth2.initTokenClient({
        client_id: clientId.trim(),
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: (resp) => {
          if (resp.error) {
            let msg = resp.error_description || resp.error;
            if (resp.error === "access_denied") {
              msg = "Acesso cancelado pelo usuário.";
            } else if (resp.error === "popup_closed_by_user") {
              msg = "A janela de login do Google foi fechada.";
            } else if (resp.error === "idpiframe_initialization_failed") {
              msg =
                "Origem não autorizada. Verifique se o domínio/porta atual está cadastrado em 'Origens JavaScript autorizadas' no Google Cloud Console.";
            }
            reject(new Error(msg));
            return;
          }

          if (resp.access_token) {
            const expiresIn = resp.expires_in || 3500;
            cachedToken = {
              token: resp.access_token,
              expiresAt: Date.now() + expiresIn * 1000,
            };
            resolve(resp.access_token);
          } else {
            reject(new Error("Token de acesso não retornado pelo Google."));
          }
        },
        error_callback: (err) => {
          reject(new Error(err?.message || "Erro na autenticação com o Google."));
        },
      });

      client.requestAccessToken({ prompt: forcePrompt ? "select_account consent" : "" });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Encontra ou cria a pasta do aplicativo no Google Drive do usuário
 */
export async function getOrCreateDriveFolder(
  accessToken: string,
  folderName = DEFAULT_FOLDER_NAME,
): Promise<string> {
  const query = encodeURIComponent(
    `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );

  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&spaces=drive`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!searchRes.ok) {
    if (searchRes.status === 401) {
      clearGoogleAuthCache();
      throw new Error("Sessão do Google expirada. Faça login novamente.");
    }
    const errText = await searchRes.text();
    throw new Error(`Falha ao buscar pasta no Drive: ${errText}`);
  }

  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  // Cria a pasta se não existir
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Falha ao criar pasta no Google Drive: ${errText}`);
  }

  const createData = await createRes.json();
  return createData.id;
}

export interface UploadOptions {
  blob: Blob;
  fileName: string;
  clientId: string;
  folderName?: string;
  onProgress?: (progress: DriveUploadProgress) => void;
  cancelRef?: { cancelled: boolean; abort?: () => void };
}

/**
 * Realiza upload resumível de vídeo (MP4 ou WebM) diretamente para o Google Drive
 * com suporte a arquivos grandes e barra de progresso em tempo real.
 */
export async function uploadVideoToGoogleDrive(options: UploadOptions): Promise<DriveUploadResult> {
  const {
    blob,
    fileName,
    clientId,
    folderName = DEFAULT_FOLDER_NAME,
    onProgress,
    cancelRef,
  } = options;

  if (cancelRef?.cancelled) {
    throw new Error("Upload cancelado.");
  }

  const accessToken = await requestGoogleAccessToken(clientId);

  if (cancelRef?.cancelled) {
    throw new Error("Upload cancelado.");
  }

  // Obtém ou cria a pasta no Drive
  const folderId = await getOrCreateDriveFolder(accessToken, folderName);

  if (cancelRef?.cancelled) {
    throw new Error("Upload cancelado.");
  }

  const mimeType = blob.type || (fileName.endsWith(".webm") ? "video/webm" : "video/mp4");

  // 1. Inicia sessão de Upload Resumível (Google Drive Resumable Upload)
  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": blob.size.toString(),
      },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId],
      }),
    },
  );

  if (!initRes.ok) {
    if (initRes.status === 401) {
      clearGoogleAuthCache();
      throw new Error("Sessão expirada. Tente novamente.");
    }
    const errText = await initRes.text();
    throw new Error(`Erro ao iniciar upload no Google Drive: ${errText}`);
  }

  const resumableUrl = initRes.headers.get("Location");
  if (!resumableUrl) {
    throw new Error("URL de upload resumível não retornada pelo Google Drive.");
  }

  // 2. Executa o upload com XMLHttpRequest para monitorar o progresso exato em tempo real
  return new Promise<DriveUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", resumableUrl, true);
    xhr.setRequestHeader("Content-Type", mimeType);

    if (cancelRef) {
      cancelRef.abort = () => {
        xhr.abort();
      };
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
        onProgress({
          percent,
          loadedBytes: e.loaded,
          totalBytes: e.total,
        });
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const fileData = JSON.parse(xhr.responseText);
          const link = `https://drive.google.com/file/d/${fileData.id}/view`;
          resolve({
            fileId: fileData.id,
            name: fileData.name || fileName,
            webViewLink: link,
            folderName,
            size: blob.size,
          });
        } catch {
          reject(new Error("Resposta inválida do Google Drive após conclusão."));
        }
      } else {
        reject(
          new Error(
            `Erro durante o envio do arquivo (${xhr.status}): ${xhr.responseText || xhr.statusText}`,
          ),
        );
      }
    };

    xhr.onerror = () => {
      if (cancelRef?.cancelled) {
        reject(new Error("Upload cancelado pelo usuário."));
      } else {
        reject(new Error("Falha na conexão de rede ao enviar o arquivo para o Google Drive."));
      }
    };

    xhr.onabort = () => {
      reject(new Error("Upload cancelado pelo usuário."));
    };

    xhr.send(blob);
  });
}
