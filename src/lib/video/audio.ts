/**
 * Decodificação de áudio no navegador — usada SOMENTE para obter a duração e
 * detectar pausas de fala (sincronização das legendas). A montagem do vídeo
 * acontece exclusivamente no FFmpeg do servidor.
 */

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

// 16 kHz é suficiente para detectar fala/silêncio. Uma narração de 10 min em
// 44,1 kHz estéreo ocupa ~210 MB como AudioBuffer; a 16 kHz cai para ~77 MB.
const ANALYSIS_SAMPLE_RATE = 16_000;

function createAnalysisContext(): AudioContext {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext não suportado");
  try {
    return new Ctx({ sampleRate: ANALYSIS_SAMPLE_RATE });
  } catch {
    return new Ctx();
  }
}

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const ctx = createAnalysisContext();
  try {
    const data = await file.arrayBuffer();
    return await ctx.decodeAudioData(data);
  } catch {
    throw new Error(`Não foi possível decodificar ${file.name}. Tente MP3, WAV, M4A/AAC ou OGG.`);
  } finally {
    void ctx.close();
  }
}
