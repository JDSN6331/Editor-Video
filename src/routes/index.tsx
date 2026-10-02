import { createFileRoute } from "@tanstack/react-router";
import { VideoProjectProvider } from "@/contexts/VideoProjectContext";
import { StudioHeader } from "@/components/studio/StudioHeader";
import { ScriptStep } from "@/components/studio/ScriptStep";
import { ImagesStep } from "@/components/studio/ImagesStep";
import { NarrationStep } from "@/components/studio/NarrationStep";
import { CaptionsStep } from "@/components/studio/CaptionsStep";
import { MusicStep } from "@/components/studio/MusicStep";
import { RenderStep } from "@/components/studio/RenderStep";
import { ThumbnailStep } from "@/components/studio/ThumbnailStep";
import { TimelineSidebar } from "@/components/studio/TimelineSidebar";
import { AboutSidebar } from "@/components/studio/AboutSidebar";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Estúdio de Criação de Vídeo" },
      {
        name: "description",
        content:
          "Editor que monta vídeos para o YouTube a partir de roteiro, imagens, narração e trilha: sincroniza as imagens com a narração, gera legendas e a thumbnail.",
      },
      { property: "og:title", content: "Estúdio de Criação de Vídeo" },
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

function Studio() {
  return (
    <VideoProjectProvider>
      <main className="studio-background min-h-screen bg-transparent">
        <StudioHeader />

        <div className="mx-auto grid max-w-6xl gap-5 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <ScriptStep />
            <ImagesStep />
            <NarrationStep />
            <CaptionsStep />
            <MusicStep />
            <RenderStep />
            <ThumbnailStep />
          </div>

          <aside className="space-y-5 lg:self-start">
            <TimelineSidebar />
            <AboutSidebar />
          </aside>
        </div>
      </main>
    </VideoProjectProvider>
  );
}
