import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Clapperboard,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Music4,
  Play,
  Square,
  Subtitles,
  Trash2,
  X,
} from "lucide-react";

import { StepCard } from "@/components/studio/StepCard";
import { FileDrop } from "@/components/studio/FileDrop";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { buildCaptions, formatTime, toSRT } from "@/lib/video/captions";
import { decodeAudio, renderVideo } from "@/lib/video/render";
import { drawThumbnail } from "@/lib/video/thumbnail";
import { VIDEO_PRESETS, type PresetKey, type SourceImage } from "@/lib/video/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Roteiro em Vídeo — Estúdio de montagem para YouTube" },
      {
        name: "description",
        content:
          "Editor que monta vídeos para o YouTube a partir de roteiro, imagens, narração e trilha: sincroniza as imagens com a narração, gera legendas e a thumbnail.",
      },
      { property: "og:title", content: "Roteiro em Vídeo — Estúdio de montagem para YouTube" },
      {
        property: "og:description",
        content:
          "Carregue roteiro, imagens, narração e trilha. O estúdio calcula o tempo de cada imagem, gera legendas e exporta o vídeo pronto.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Studio,
});

const ACCENTS = ["#ff7a29", "#ffd23f", "#4cc9f0", "#f72585", "#39d98a"];

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function Studio() {
  // 1 - roteiro
  const [script, setScript] = useState("");
  // 2 - imagens
  const [images, setImages] = useState<SourceImage[]>([]);
  // 3 - narração
  const [narration, setNarration] = useState<{
    name: string;
    url: string;
    buffer: AudioBuffer;
  } | null>(null);
  // 5 - música
  const [music, setMusic] = useState<{ name: string; url: string; buffer: AudioBuffer } | null>(
    null,
  );
  const [musicVolume, setMusicVolume] = useState(12);
  const [narrationVolume, setNarrationVolume] = useState(100);
  const [duckOnly, setDuckOnly] = useState(true);

  // 4 - legendas
  const [showCaptions, setShowCaptions] = useState(true);
  const [maxChars, setMaxChars] = useState(90);

  // 6 - vídeo
  const [preset, setPreset] = useState<PresetKey>("1080p");
  const [fps, setFps] = useState(30);
  const [kenBurns, setKenBurns] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ url: string; extension: string; size: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const cancelRef = useRef({ cancelled: false });

  // 7 - thumbnail
  const [thumbIndex, setThumbIndex] = useState(0);
  const [thumbTitle, setThumbTitle] = useState("");
  const [thumbSubtitle, setThumbSubtitle] = useState("");
  const [accent, setAccent] = useState(ACCENTS[0]!);
  const thumbCanvasRef = useRef<HTMLCanvasElement>(null);

  const duration = narration?.buffer.duration ?? 0;
  const perImage = images.length ? duration / images.length : 0;

  const captions = useMemo(
    () => (script.trim() && duration ? buildCaptions(script, duration, maxChars) : []),
    [script, duration, maxChars],
  );

  const effectiveMusicVolume = (duckOnly ? Math.min(musicVolume, 30) : musicVolume) / 100;

  const addImages = useCallback(async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith("image/"));
    const loaded = await Promise.all(
      picked.map(
        (file) =>
          new Promise<SourceImage>((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const el = new Image();
            el.onload = () =>
              resolve({ id: `${file.name}-${crypto.randomUUID()}`, name: file.name, url, element: el });
            el.onerror = () => reject(new Error(`Não foi possível ler ${file.name}`));
            el.src = url;
          }),
      ),
    );
    setImages((prev) => [...prev, ...loaded]);
  }, []);

  const loadAudio = useCallback(async (file: File, kind: "narration" | "music") => {
    const buffer = await decodeAudio(file);
    const url = URL.createObjectURL(file);
    if (kind === "narration") setNarration({ name: file.name, url, buffer });
    else setMusic({ name: file.name, url, buffer });
  }, []);

  useEffect(() => {
    if (!thumbTitle && script.trim()) {
      setThumbTitle(script.trim().split(/[.!?\n]/)[0]!.slice(0, 70));
    }
  }, [script, thumbTitle]);

  useEffect(() => {
    const canvas = thumbCanvasRef.current;
    const img = images[thumbIndex];
    if (!canvas || !img) return;
    drawThumbnail(canvas, {
      image: img.element,
      title: thumbTitle || "Seu título aqui",
      subtitle: thumbSubtitle,
      accent,
    });
  }, [images, thumbIndex, thumbTitle, thumbSubtitle, accent]);

  const handleRender = async () => {
    if (!narration || !images.length) return;
    setError(null);
    setResult(null);
    setProgress(0);
    setRendering(true);
    cancelRef.current = { cancelled: false };
    try {
      const { width, height } = VIDEO_PRESETS[preset];
      const out = await renderVideo({
        images: images.map((i) => i.element),
        narrationBuffer: narration.buffer,
        musicBuffer: music?.buffer ?? null,
        musicVolume: effectiveMusicVolume,
        narrationVolume: narrationVolume / 100,
        captions: showCaptions ? captions : null,
        width,
        height,
        fps,
        kenBurns,
        fade: Math.min(0.6, perImage / 4),
        previewCanvas: previewRef.current,
        onProgress: (elapsed, total) => setProgress((elapsed / total) * 100),
        cancelRef: cancelRef.current,
      });
      setResult({
        url: URL.createObjectURL(out.blob),
        extension: out.extension,
        size: out.blob.size,
      });
      setProgress(100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao montar o vídeo.");
    } finally {
      setRendering(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div className="flex items-center gap-3">
            <span
              className="flex size-10 items-center justify-center rounded-xl"
              style={{ background: "var(--gradient-studio)" }}
            >
              <Clapperboard className="size-5 text-primary-foreground" />
            </span>
            <div>
              <h1 className="font-display text-xl font-bold">Estúdio de Vídeo</h1>
              <p className="text-xs text-muted-foreground">
                Roteiro, imagens, narração e trilha → vídeo pronto para o YouTube
              </p>
            </div>
          </div>
          <div className="flex items-center gap-5 text-sm">
            <Stat label="Duração" value={duration ? formatTime(duration) : "—"} />
            <Stat label="Imagens" value={images.length ? String(images.length) : "—"} />
            <Stat
              label="Tempo por imagem"
              value={perImage ? `${perImage.toFixed(3).replace(".", ",")}s` : "—"}
            />
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-5 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
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
              <FileDropInline
                accept=".txt,.md,text/plain"
                label="Carregar .txt"
                onFile={async (file) => setScript(await file.text())}
              />
              <span>{script.trim() ? `${script.trim().split(/\s+/).length} palavras` : "vazio"}</span>
            </div>
          </StepCard>

          <StepCard
            index={2}
            title="Imagens"
            description="A ordem da lista é a ordem de exibição no vídeo."
            done={images.length > 0}
            aside={
              images.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setImages([])}>
                  <Trash2 className="size-4" /> limpar
                </Button>
              ) : undefined
            }
          >
            <FileDrop accept="image/*" multiple onFiles={addImages}>
              <ImageIcon className="size-6" />
              <span>Arraste as imagens ou clique para selecionar</span>
            </FileDrop>
            {images.length > 0 && (
              <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
                {images.map((img, i) => (
                  <li key={img.id} className="group relative overflow-hidden rounded-lg border border-border">
                    <img src={img.url} alt={img.name} className="aspect-video w-full object-cover" />
                    <span className="absolute left-1 top-1 rounded bg-background/80 px-1.5 text-[11px] font-semibold">
                      {i + 1}
                    </span>
                    {perImage > 0 && (
                      <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1.5 text-[10px]">
                        {perImage.toFixed(2).replace(".", ",")}s
                      </span>
                    )}
                    <button
                      onClick={() => setImages((prev) => prev.filter((p) => p.id !== img.id))}
                      className="absolute right-1 top-1 rounded bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label={`Remover ${img.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </StepCard>

          <StepCard
            index={3}
            title="Narração"
            description="A duração da narração define a duração do vídeo e o tempo de cada imagem."
            done={!!narration}
          >
            <FileDrop
              accept="audio/*"
              onFiles={(files) => files[0] && loadAudio(files[0], "narration")}
            >
              <AudioLines className="size-6" />
              <span>{narration ? narration.name : "Arraste o áudio da narração (mp3, wav, m4a)"}</span>
            </FileDrop>
            {narration && (
              <div className="mt-4 space-y-3">
                <audio controls src={narration.url} className="w-full" />
                <div className="rounded-lg border border-border bg-secondary/40 p-3 text-sm">
                  <p>
                    Narração de <strong>{formatTime(duration, true)}</strong>
                    {images.length > 0 && (
                      <>
                        {" "}
                        ÷ {images.length} imagens ={" "}
                        <strong>{perImage.toFixed(3).replace(".", ",")} s</strong> por imagem
                      </>
                    )}
                  </p>
                </div>
              </div>
            )}
          </StepCard>

          <StepCard
            index={4}
            title="Legendas"
            description="Geradas a partir do roteiro e distribuídas ao longo da narração."
            done={captions.length > 0}
            aside={
              <div className="flex items-center gap-2">
                <Label htmlFor="cap" className="text-xs text-muted-foreground">
                  no vídeo
                </Label>
                <Switch id="cap" checked={showCaptions} onCheckedChange={setShowCaptions} />
              </div>
            }
          >
            <div className="flex flex-wrap items-center gap-4">
              <div className="min-w-48 flex-1">
                <Label className="text-xs text-muted-foreground">
                  Máximo de caracteres por bloco: {maxChars}
                </Label>
                <Slider
                  value={[maxChars]}
                  min={40}
                  max={140}
                  step={5}
                  onValueChange={([v]) => setMaxChars(v ?? 90)}
                  className="mt-2"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={!captions.length}
                onClick={() =>
                  download(new Blob([toSRT(captions)], { type: "text/plain" }), "legendas.srt")
                }
              >
                <Subtitles className="size-4" /> Baixar .srt
              </Button>
            </div>
            {captions.length > 0 ? (
              <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-secondary/30 p-2 text-sm">
                {captions.map((c, i) => (
                  <li key={i} className="flex gap-3 rounded px-2 py-1 hover:bg-secondary">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {formatTime(c.start)}
                    </span>
                    <span>{c.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                Carregue o roteiro e a narração para gerar as legendas.
              </p>
            )}
          </StepCard>

          <StepCard
            index={5}
            title="Música de fundo"
            description="Fica em loop sob a narração, com fade out no final."
            done={!!music}
          >
            <FileDrop accept="audio/*" onFiles={(files) => files[0] && loadAudio(files[0], "music")}>
              <Music4 className="size-6" />
              <span>{music ? music.name : "Arraste a trilha de fundo"}</span>
            </FileDrop>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="text-xs text-muted-foreground">
                  Volume da música: {duckOnly ? Math.min(musicVolume, 30) : musicVolume}%
                </Label>
                <Slider
                  value={[musicVolume]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={([v]) => setMusicVolume(v ?? 0)}
                  className="mt-2"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">
                  Volume da narração: {narrationVolume}%
                </Label>
                <Slider
                  value={[narrationVolume]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={([v]) => setNarrationVolume(v ?? 100)}
                  className="mt-2"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-secondary/40 p-3">
              <Switch id="duck" checked={duckOnly} onCheckedChange={setDuckOnly} />
              <Label htmlFor="duck" className="text-sm font-normal">
                Proteger a narração (limita a trilha a 30% do volume)
              </Label>
            </div>
          </StepCard>

          <StepCard
            index={6}
            title="Montar o vídeo"
            description="A renderização acontece em tempo real, então leva o mesmo tempo da narração."
            done={!!result}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label className="text-xs text-muted-foreground">Resolução</Label>
                <div className="mt-2 flex gap-2">
                  {(Object.keys(VIDEO_PRESETS) as PresetKey[]).map((key) => (
                    <Button
                      key={key}
                      size="sm"
                      variant={preset === key ? "default" : "secondary"}
                      onClick={() => setPreset(key)}
                    >
                      {key}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">FPS</Label>
                <div className="mt-2 flex gap-2">
                  {[24, 30, 60].map((f) => (
                    <Button
                      key={f}
                      size="sm"
                      variant={fps === f ? "default" : "secondary"}
                      onClick={() => setFps(f)}
                    >
                      {f}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-end gap-3">
                <Switch id="kb" checked={kenBurns} onCheckedChange={setKenBurns} />
                <Label htmlFor="kb" className="pb-1 text-sm font-normal">
                  Movimento suave nas imagens
                </Label>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                onClick={handleRender}
                disabled={rendering || !narration || !images.length}
                size="lg"
              >
                <Play className="size-4" /> Montar vídeo
              </Button>
              {rendering && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    cancelRef.current.cancelled = true;
                  }}
                >
                  <Square className="size-4" /> Parar
                </Button>
              )}
              {result && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    fetch(result.url)
                      .then((r) => r.blob())
                      .then((b) => download(b, `video-youtube.${result.extension}`))
                  }
                >
                  <Download className="size-4" /> Baixar vídeo (
                  {(result.size / 1024 / 1024).toFixed(1)} MB)
                </Button>
              )}
            </div>

            {rendering && (
              <div className="mt-4">
                <Progress value={progress} />
                <p className="mt-2 text-xs text-muted-foreground">
                  {formatTime((progress / 100) * duration)} de {formatTime(duration)} — mantenha
                  esta aba aberta e em primeiro plano.
                </p>
              </div>
            )}
            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

            <div className="mt-5 overflow-hidden rounded-xl border border-border bg-black">
              {result ? (
                <video src={result.url} controls className="w-full" />
              ) : (
                <canvas ref={previewRef} className="aspect-video w-full" />
              )}
            </div>
          </StepCard>

          <StepCard
            index={7}
            title="Thumbnail"
            description="1280×720 com a legenda em destaque, pronta para subir junto do vídeo."
            done={!!images.length && !!thumbTitle}
          >
            {images.length === 0 ? (
              <p className="text-sm text-muted-foreground">Carregue imagens para criar a capa.</p>
            ) : (
              <div className="space-y-4">
                <canvas
                  ref={thumbCanvasRef}
                  className="w-full rounded-xl border border-border bg-black"
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">Título</Label>
                    <Input
                      value={thumbTitle}
                      onChange={(e) => setThumbTitle(e.target.value)}
                      className="mt-1 bg-secondary/40"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Chamada (opcional)</Label>
                    <Input
                      value={thumbSubtitle}
                      onChange={(e) => setThumbSubtitle(e.target.value)}
                      className="mt-1 bg-secondary/40"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-muted-foreground">Cor:</span>
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setAccent(c)}
                      aria-label={`Cor ${c}`}
                      className="size-6 rounded-full border-2"
                      style={{ background: c, borderColor: accent === c ? "#fff" : "transparent" }}
                    />
                  ))}
                  <span className="ml-3 text-xs text-muted-foreground">Imagem:</span>
                  <div className="flex gap-1">
                    {images.slice(0, 8).map((img, i) => (
                      <button
                        key={img.id}
                        onClick={() => setThumbIndex(i)}
                        className="overflow-hidden rounded border-2"
                        style={{ borderColor: thumbIndex === i ? accent : "transparent" }}
                      >
                        <img src={img.url} alt="" className="h-8 w-14 object-cover" />
                      </button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto"
                    onClick={() =>
                      thumbCanvasRef.current?.toBlob(
                        (b) => b && download(b, "thumbnail.png"),
                        "image/png",
                      )
                    }
                  >
                    <Download className="size-4" /> Baixar thumbnail
                  </Button>
                </div>
              </div>
            )}
          </StepCard>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">
          <div
            className="rounded-2xl border border-border bg-card p-5"
            style={{ boxShadow: "var(--shadow-panel)" }}
          >
            <h2 className="font-display text-base font-semibold">Linha do tempo</h2>
            {duration && images.length ? (
              <>
                <div className="mt-3 flex h-8 overflow-hidden rounded-lg border border-border">
                  {images.map((img, i) => (
                    <span
                      key={img.id}
                      title={`${img.name} — ${perImage.toFixed(3)}s`}
                      className="flex-1 border-r border-background/60 bg-cover bg-center last:border-0"
                      style={{ backgroundImage: `url(${img.url})` }}
                    />
                  ))}
                </div>
                <div className="mt-2 flex h-3 items-center gap-1">
                  <span className="h-2 flex-1 rounded bg-primary/70" title="narração" />
                </div>
                {music && (
                  <div className="mt-1 flex h-3 items-center gap-1">
                    <span
                      className="h-2 flex-1 rounded bg-accent/70"
                      style={{ opacity: Math.max(0.25, effectiveMusicVolume) }}
                      title="música"
                    />
                  </div>
                )}
                <dl className="mt-4 space-y-1 text-sm">
                  <Row label="Duração final" value={formatTime(duration, true)} />
                  <Row label="Imagens" value={`${images.length}`} />
                  <Row
                    label="Tempo por imagem"
                    value={`${perImage.toFixed(3).replace(".", ",")} s`}
                  />
                  <Row label="Blocos de legenda" value={`${captions.length}`} />
                  <Row
                    label="Saída"
                    value={`${VIDEO_PRESETS[preset].width}×${VIDEO_PRESETS[preset].height} · ${fps}fps`}
                  />
                </dl>
              </>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Carregue a narração e as imagens para ver a divisão de tempo.
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-secondary/30 p-5 text-sm text-muted-foreground">
            <h2 className="mb-2 flex items-center gap-2 font-display text-base font-semibold text-foreground">
              <Film className="size-4" /> Sobre o protótipo
            </h2>
            <ul className="space-y-2">
              <li>
                A montagem roda no navegador (canvas + WebAudio) e gera um arquivo WebM/VP9, formato
                aceito pelo YouTube.
              </li>
              <li>
                A renderização é em tempo real: um vídeo de 5 minutos leva 5 minutos para ser
                montado.
              </li>
              <li>
                Para exportar em MP4/H.264 e renderizar mais rápido que o tempo real, o próximo
                passo local é plugar FFmpeg (WASM ou servidor) usando as mesmas funções em{" "}
                <code className="text-foreground">src/lib/video</code>.
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-display font-semibold">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function FileDropInline({
  accept,
  label,
  onFile,
}: {
  accept: string;
  label: string;
  onFile: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => ref.current?.click()}>
        <FileText className="size-4" /> {label}
      </Button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}
