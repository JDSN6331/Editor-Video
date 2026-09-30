import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Caption, PresetKey, SourceImage } from "@/lib/video/types";
import { buildCaptions } from "@/lib/video/captions";
import { decodeAudio } from "@/lib/video/render";
import { getDbInfoFn, getProjectFn, saveProjectFn } from "@/api/projects";
import { toast } from "sonner";

export const ACCENTS = ["#ff7a29", "#ffd23f", "#4cc9f0", "#ef4444", "#39d98a"];

export interface AudioItem {
  name: string;
  url: string;
  dataUrl?: string;
  buffer: AudioBuffer;
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";
export type FileLoadStatus = "idle" | "reading" | "processing" | "ready" | "error";
export type FileLoadKind = "script" | "images" | "narration" | "music";

export interface FileLoadProgress {
  status: FileLoadStatus;
  progress: number;
  message: string;
}

interface VideoProjectContextType {
  // Database & Project Meta
  projectId: string;
  projectName: string;
  setProjectName: (name: string) => void;
  dbType: "sqlite" | "postgres";
  saveStatus: SaveStatus;
  lastSavedAt: Date | null;
  saveProjectToDb: (customName: string) => Promise<boolean>;
  loadProjectFromDb: (id: string) => Promise<void>;
  createNewProject: () => void;

  // Script
  script: string;
  setScript: (value: string) => void;
  loadScriptFile: (file: File) => Promise<void>;

  // Images
  images: SourceImage[];
  setImages: React.Dispatch<React.SetStateAction<SourceImage[]>>;
  addImages: (files: File[]) => Promise<void>;
  removeImage: (id: string) => void;
  moveImage: (index: number, direction: -1 | 1) => void;
  reorderImages: (fromIndex: number, toIndex: number) => void;

  // Narration
  narration: AudioItem | null;
  setNarration: React.Dispatch<React.SetStateAction<AudioItem | null>>;

  // Music
  music: AudioItem | null;
  setMusic: React.Dispatch<React.SetStateAction<AudioItem | null>>;
  musicVolume: number;
  setMusicVolume: (value: number) => void;
  narrationVolume: number;
  setNarrationVolume: (value: number) => void;
  duckOnly: boolean;
  setDuckOnly: (value: boolean) => void;

  // Captions
  showCaptions: boolean;
  setShowCaptions: (value: boolean) => void;
  maxChars: number;
  setMaxChars: (value: number) => void;
  captions: Caption[];

  // Video settings & Format
  preset: PresetKey;
  setPreset: (value: PresetKey) => void;
  fps: number;
  setFps: (value: number) => void;
  kenBurns: boolean;
  setKenBurns: (value: boolean) => void;
  preferredFormat: "mp4" | "webm";
  setPreferredFormat: (value: "mp4" | "webm") => void;

  // Timeline preview
  previewTime: number;
  setPreviewTime: React.Dispatch<React.SetStateAction<number>>;

  // Render state
  rendering: boolean;
  setRendering: (value: boolean) => void;
  progress: number;
  setProgress: (value: number) => void;
  result: { url: string; extension: string; size: number } | null;
  setResult: (value: { url: string; extension: string; size: number } | null) => void;
  error: string | null;
  setError: (value: string | null) => void;

  // Thumbnail
  thumbIndex: number;
  setThumbIndex: (value: number) => void;
  thumbTitle: string;
  setThumbTitle: (value: string) => void;
  thumbSubtitle: string;
  setThumbSubtitle: (value: string) => void;
  accent: string;
  setAccent: (value: string) => void;

  // Derived values
  duration: number;
  perImage: number;
  effectiveMusicVolume: number;
  fileLoadProgress: Record<FileLoadKind, FileLoadProgress>;

  // Audio loading
  loadAudio: (file: File, kind: "narration" | "music") => Promise<void>;
}

const VideoProjectContext = createContext<VideoProjectContextType | null>(null);

export function useVideoProject() {
  const ctx = useContext(VideoProjectContext);
  if (!ctx) {
    throw new Error("useVideoProject must be used within a VideoProjectProvider");
  }
  return ctx;
}

function fileToDataUrl(
  file: File | Blob,
  onProgress?: (progress: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o arquivo."));
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.((event.loaded / event.total) * 100);
      }
    };
    reader.readAsDataURL(file);
  });
}

function fileToText(file: File, onProgress?: (progress: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o roteiro."));
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.((event.loaded / event.total) * 100);
      }
    };
    reader.readAsText(file);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const arr = dataUrl.split(",");
  const mimeMatch = arr[0]?.match(/:(.*?);/);
  const mime: string = mimeMatch?.[1] ?? "application/octet-stream";
  const bstr = atob(arr[1] || "");
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

export function VideoProjectProvider({ children }: { children: ReactNode }) {
  // Project & DB State
  const [projectId, setProjectId] = useState<string>(() => {
    return (
      (typeof localStorage !== "undefined" && localStorage.getItem("current_project_id")) ||
      crypto.randomUUID()
    );
  });
  const [projectName, setProjectName] = useState("Novo vídeo");
  const [dbType, setDbType] = useState<"sqlite" | "postgres">("sqlite");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [fileLoadProgress, setFileLoadProgress] = useState<Record<FileLoadKind, FileLoadProgress>>({
    script: { status: "idle", progress: 0, message: "" },
    images: { status: "idle", progress: 0, message: "" },
    narration: { status: "idle", progress: 0, message: "" },
    music: { status: "idle", progress: 0, message: "" },
  });

  const updateFileLoadProgress = useCallback((kind: FileLoadKind, value: FileLoadProgress) => {
    setFileLoadProgress((current) => ({ ...current, [kind]: value }));
  }, []);

  // 1 — Roteiro
  const [script, setScript] = useState("");

  // 2 — Imagens
  const [images, setImages] = useState<SourceImage[]>([]);

  // 3 — Narração
  const [narration, setNarration] = useState<AudioItem | null>(null);

  // 4 — Legendas
  const [showCaptions, setShowCaptions] = useState(true);
  const [maxChars, setMaxChars] = useState(90);

  // 5 — Música de fundo
  const [music, setMusic] = useState<AudioItem | null>(null);
  const [musicVolume, setMusicVolume] = useState(12);
  const [narrationVolume, setNarrationVolume] = useState(100);
  const [duckOnly, setDuckOnly] = useState(true);

  // 6 — Vídeo & Formato
  const [preset, setPreset] = useState<PresetKey>("1080p");
  const [fps, setFps] = useState(30);
  const [kenBurns, setKenBurns] = useState(true);
  const [preferredFormat, setPreferredFormat] = useState<"mp4" | "webm">("mp4");
  const [previewTime, setPreviewTime] = useState(0);

  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    extension: string;
    size: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 7 — Thumbnail
  const [thumbIndex, setThumbIndex] = useState(0);
  const [thumbTitle, setThumbTitle] = useState("");
  const [thumbSubtitle, setThumbSubtitle] = useState("");
  const [accent, setAccent] = useState(ACCENTS[0]!);

  /* ── Valores derivados ── */
  const duration = narration?.buffer.duration ?? 0;
  const perImage = images.length ? duration / images.length : 0;
  const effectiveMusicVolume = (duckOnly ? Math.min(musicVolume, 30) : musicVolume) / 100;

  const captions = useMemo(
    () => (script.trim() && duration ? buildCaptions(script, duration, maxChars) : []),
    [script, duration, maxChars],
  );

  /* ── Detectar Banco de Dados ── */
  useEffect(() => {
    getDbInfoFn()
      .then((info) => {
        if (info.dbType === "postgres" || info.dbType === "sqlite") {
          setDbType(info.dbType);
        }
      })
      .catch(() => {
        // Fallback local
      });
  }, []);

  /* ── Carregar roteiro com progresso ── */
  const loadScriptFile = useCallback(
    async (file: File) => {
      updateFileLoadProgress("script", {
        status: "reading",
        progress: 0,
        message: `Lendo ${file.name}…`,
      });
      try {
        const text = await fileToText(file, (progress) =>
          updateFileLoadProgress("script", {
            status: "reading",
            progress,
            message: `Lendo ${file.name}…`,
          }),
        );
        setScript(text);
        updateFileLoadProgress("script", {
          status: "ready",
          progress: 100,
          message: `${file.name} carregado`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao carregar o roteiro.";
        updateFileLoadProgress("script", { status: "error", progress: 0, message });
        toast.error(message);
      }
    },
    [updateFileLoadProgress],
  );

  /* ── Carregar imagens com DataURL para persistência ── */
  const addImages = useCallback(
    async (files: File[]) => {
      const picked = files.filter((f) => f.type.startsWith("image/"));
      if (!picked.length) {
        const message = "Selecione arquivos de imagem válidos.";
        updateFileLoadProgress("images", { status: "error", progress: 0, message });
        toast.error(message);
        return;
      }

      updateFileLoadProgress("images", {
        status: "reading",
        progress: 0,
        message: `Carregando ${picked.length} imagem(ns)…`,
      });

      try {
        const itemProgress = new Array<number>(picked.length).fill(0);
        const loaded = await Promise.all(
          picked.map(async (file, index) => {
            const dataUrl = await fileToDataUrl(file, (progress) => {
              itemProgress[index] = progress;
              const total = itemProgress.reduce((sum, value) => sum + value, 0) / picked.length;
              updateFileLoadProgress("images", {
                status: "reading",
                progress: Math.min(90, total * 0.9),
                message: `Lendo ${file.name}…`,
              });
            });
            updateFileLoadProgress("images", {
              status: "processing",
              progress: 90 + ((index + 1) / picked.length) * 9,
              message: `Validando ${file.name}…`,
            });
            return new Promise<SourceImage>((resolve, reject) => {
              const el = new Image();
              el.onload = () =>
                resolve({
                  id: `${file.name}-${crypto.randomUUID()}`,
                  name: file.name,
                  url: dataUrl,
                  dataUrl,
                  element: el,
                });
              el.onerror = () => reject(new Error(`Não foi possível ler ${file.name}`));
              el.src = dataUrl;
            });
          }),
        );
        setImages((prev) => [...prev, ...loaded]);
        updateFileLoadProgress("images", {
          status: "ready",
          progress: 100,
          message: `${loaded.length} imagem(ns) pronta(s)`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha ao carregar as imagens.";
        updateFileLoadProgress("images", { status: "error", progress: 0, message });
        toast.error(message);
      }
    },
    [updateFileLoadProgress],
  );

  /* ── Manipulação de Imagens (Reordenar e Remover) ── */
  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const moveImage = useCallback((index: number, direction: -1 | 1) => {
    setImages((prev) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const copy = [...prev];
      const temp = copy[index]!;
      copy[index] = copy[targetIndex]!;
      copy[targetIndex] = temp;
      return copy;
    });
  }, []);

  const reorderImages = useCallback((fromIndex: number, toIndex: number) => {
    setImages((prev) => {
      if (fromIndex < 0 || fromIndex >= prev.length || toIndex < 0 || toIndex >= prev.length) {
        return prev;
      }
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      if (moved) copy.splice(toIndex, 0, moved);
      return copy;
    });
  }, []);

  /* ── Carregar áudio com DataURL para persistência ── */
  const loadAudio = useCallback(
    async (file: File, kind: "narration" | "music") => {
      const label = kind === "narration" ? "narração" : "música";
      if (
        !file.type.startsWith("audio/") &&
        !/\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(file.name)
      ) {
        const message = `${file.name} não é um arquivo de áudio reconhecido.`;
        updateFileLoadProgress(kind, { status: "error", progress: 0, message });
        toast.error(message);
        return;
      }

      updateFileLoadProgress(kind, {
        status: "reading",
        progress: 0,
        message: `Lendo ${file.name}…`,
      });

      try {
        const dataUrl = await fileToDataUrl(file, (progress) =>
          updateFileLoadProgress(kind, {
            status: "reading",
            progress: progress * 0.7,
            message: `Lendo ${file.name}…`,
          }),
        );
        updateFileLoadProgress(kind, {
          status: "processing",
          progress: 75,
          message: `Decodificando ${label}…`,
        });
        const buffer = await decodeAudio(file);
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
          throw new Error(`O arquivo de ${label} não possui duração válida.`);
        }
        const item: AudioItem = {
          name: file.name,
          url: dataUrl,
          dataUrl,
          buffer,
        };
        if (kind === "narration") setNarration(item);
        else setMusic(item);
        updateFileLoadProgress(kind, {
          status: "ready",
          progress: 100,
          message: `${file.name} pronto (${buffer.duration.toFixed(1)} s)`,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "formato não suportado";
        const message = `Falha ao carregar ${label}: ${detail}`;
        updateFileLoadProgress(kind, { status: "error", progress: 0, message });
        toast.error(message);
      }
    },
    [updateFileLoadProgress],
  );

  /* ── Salvar Projeto no Banco de Dados (SQLite / PostgreSQL) ── */
  const saveProjectToDb = useCallback(
    async (customName: string) => {
      const nameToSave = customName.trim();
      if (!nameToSave) {
        toast.error("Informe um nome para o projeto.");
        return false;
      }
      setSaveStatus("saving");

      try {
        const imagesData = images.map((img) => ({
          id: img.id,
          name: img.name,
          dataUrl: img.dataUrl || img.url,
        }));

        const narrationData = narration
          ? {
              name: narration.name,
              dataUrl: narration.dataUrl || narration.url,
            }
          : null;

        const musicData = music
          ? {
              name: music.name,
              dataUrl: music.dataUrl || music.url,
            }
          : null;

        await saveProjectFn({
          data: {
            id: projectId,
            name: nameToSave,
            script,
            musicVolume,
            narrationVolume,
            duckOnly,
            showCaptions,
            maxChars,
            preset,
            fps,
            kenBurns,
            thumbTitle,
            thumbSubtitle,
            accent,
            thumbIndex,
            imagesJson: JSON.stringify(imagesData),
            narrationJson: narrationData ? JSON.stringify(narrationData) : null,
            musicJson: musicData ? JSON.stringify(musicData) : null,
          },
        });

        if (typeof localStorage !== "undefined") {
          localStorage.setItem("current_project_id", projectId);
        }

        setSaveStatus("saved");
        setLastSavedAt(new Date());
        setProjectName(nameToSave);
        return true;
      } catch (err) {
        console.error("Erro ao salvar projeto:", err);
        setSaveStatus("error");
        toast.error("Falha ao salvar projeto no banco de dados.");
        return false;
      }
    },
    [
      projectId,
      script,
      musicVolume,
      narrationVolume,
      duckOnly,
      showCaptions,
      maxChars,
      preset,
      fps,
      kenBurns,
      thumbTitle,
      thumbSubtitle,
      accent,
      thumbIndex,
      images,
      narration,
      music,
    ],
  );

  /* ── Carregar Projeto do Banco de Dados ── */
  const loadProjectFromDb = useCallback(async (id: string) => {
    try {
      setSaveStatus("saving");
      const proj = await getProjectFn({ data: id });
      if (!proj) {
        toast.error("Projeto não encontrado.");
        setSaveStatus("idle");
        return;
      }

      setProjectId(proj.id);
      setProjectName(proj.name);
      setScript(proj.script || "");
      setMusicVolume(proj.musicVolume ?? 12);
      setNarrationVolume(proj.narrationVolume ?? 100);
      setDuckOnly(proj.duckOnly ?? true);
      setShowCaptions(proj.showCaptions ?? true);
      setMaxChars(proj.maxChars ?? 90);
      setPreset((proj.preset as PresetKey) || "1080p");
      setFps(proj.fps ?? 30);
      setKenBurns(proj.kenBurns ?? true);
      const previousAutomaticTitle = (proj.script || "")
        .trim()
        .split(/[.!?\n]/)[0]
        ?.slice(0, 70);
      setThumbTitle(proj.thumbTitle === previousAutomaticTitle ? "" : proj.thumbTitle || "");
      setThumbSubtitle(proj.thumbSubtitle || "");
      setAccent(proj.accent || ACCENTS[0]!);
      setThumbIndex(proj.thumbIndex ?? 0);

      // Reconstruir imagens
      if (proj.imagesJson) {
        try {
          const rawImages = JSON.parse(proj.imagesJson) as Array<{
            id: string;
            name: string;
            dataUrl: string;
          }>;
          const loadedImages = await Promise.all(
            rawImages.map(
              (img) =>
                new Promise<SourceImage>((resolve) => {
                  const el = new Image();
                  el.onload = () =>
                    resolve({
                      id: img.id,
                      name: img.name,
                      url: img.dataUrl,
                      dataUrl: img.dataUrl,
                      element: el,
                    });
                  el.onerror = () =>
                    resolve({
                      id: img.id,
                      name: img.name,
                      url: img.dataUrl,
                      dataUrl: img.dataUrl,
                      element: el,
                    });
                  el.src = img.dataUrl;
                }),
            ),
          );
          setImages(loadedImages);
        } catch (e) {
          console.error("Falha ao reconstruir imagens:", e);
        }
      }

      // Reconstruir narração
      if (proj.narrationJson) {
        try {
          const rawNarr = JSON.parse(proj.narrationJson) as {
            name: string;
            dataUrl: string;
          };
          const blob = dataUrlToBlob(rawNarr.dataUrl);
          const file = new File([blob], rawNarr.name, { type: blob.type });
          const buffer = await decodeAudio(file);
          setNarration({
            name: rawNarr.name,
            url: rawNarr.dataUrl,
            dataUrl: rawNarr.dataUrl,
            buffer,
          });
        } catch (e) {
          console.error("Falha ao decodificar narração:", e);
        }
      } else {
        setNarration(null);
      }

      // Reconstruir música
      if (proj.musicJson) {
        try {
          const rawMus = JSON.parse(proj.musicJson) as {
            name: string;
            dataUrl: string;
          };
          const blob = dataUrlToBlob(rawMus.dataUrl);
          const file = new File([blob], rawMus.name, { type: blob.type });
          const buffer = await decodeAudio(file);
          setMusic({
            name: rawMus.name,
            url: rawMus.dataUrl,
            dataUrl: rawMus.dataUrl,
            buffer,
          });
        } catch (e) {
          console.error("Falha ao decodificar música:", e);
        }
      } else {
        setMusic(null);
      }

      if (typeof localStorage !== "undefined") {
        localStorage.setItem("current_project_id", proj.id);
      }

      setSaveStatus("saved");
      setLastSavedAt(new Date());
      toast.success(`Projeto "${proj.name}" carregado com sucesso!`);
    } catch (err) {
      console.error("Erro ao carregar projeto:", err);
      toast.error("Erro ao carregar projeto do banco de dados.");
      setSaveStatus("error");
    }
  }, []);

  /* ── Criar Novo Projeto ── */
  const createNewProject = useCallback(() => {
    const newId = crypto.randomUUID();
    setProjectId(newId);
    setProjectName("Novo vídeo");
    setScript("");
    setImages([]);
    setNarration(null);
    setMusic(null);
    setResult(null);
    setThumbTitle("");
    setThumbSubtitle("");
    setFileLoadProgress({
      script: { status: "idle", progress: 0, message: "" },
      images: { status: "idle", progress: 0, message: "" },
      narration: { status: "idle", progress: 0, message: "" },
      music: { status: "idle", progress: 0, message: "" },
    });
    setSaveStatus("idle");
    setLastSavedAt(null);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("current_project_id", newId);
    }
    toast.info("Novo projeto criado.");
  }, []);

  /* ── Valor do contexto (memoizado) ── */
  const value = useMemo<VideoProjectContextType>(
    () => ({
      projectId,
      projectName,
      setProjectName,
      dbType,
      saveStatus,
      lastSavedAt,
      saveProjectToDb,
      loadProjectFromDb,
      createNewProject,
      script,
      setScript,
      loadScriptFile,
      images,
      setImages,
      addImages,
      removeImage,
      moveImage,
      reorderImages,
      narration,
      setNarration,
      music,
      setMusic,
      musicVolume,
      setMusicVolume,
      narrationVolume,
      setNarrationVolume,
      duckOnly,
      setDuckOnly,
      showCaptions,
      setShowCaptions,
      maxChars,
      setMaxChars,
      captions,
      preset,
      setPreset,
      fps,
      setFps,
      kenBurns,
      setKenBurns,
      preferredFormat,
      setPreferredFormat,
      previewTime,
      setPreviewTime,
      rendering,
      setRendering,
      progress,
      setProgress,
      result,
      setResult,
      error,
      setError,
      thumbIndex,
      setThumbIndex,
      thumbTitle,
      setThumbTitle,
      thumbSubtitle,
      setThumbSubtitle,
      accent,
      setAccent,
      duration,
      perImage,
      effectiveMusicVolume,
      fileLoadProgress,
      loadAudio,
    }),
    [
      projectId,
      projectName,
      dbType,
      saveStatus,
      lastSavedAt,
      saveProjectToDb,
      loadProjectFromDb,
      createNewProject,
      script,
      loadScriptFile,
      images,
      addImages,
      removeImage,
      moveImage,
      reorderImages,
      narration,
      music,
      musicVolume,
      narrationVolume,
      duckOnly,
      showCaptions,
      maxChars,
      captions,
      preset,
      fps,
      kenBurns,
      preferredFormat,
      previewTime,
      rendering,
      progress,
      result,
      error,
      thumbIndex,
      thumbTitle,
      thumbSubtitle,
      accent,
      duration,
      perImage,
      effectiveMusicVolume,
      fileLoadProgress,
      loadAudio,
    ],
  );

  return <VideoProjectContext.Provider value={value}>{children}</VideoProjectContext.Provider>;
}
