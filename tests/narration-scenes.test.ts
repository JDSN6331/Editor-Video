import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface AudioBufferLike {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

let vite: ViteDevServer;
let detectScenesFromAudio: (
  buffer: AudioBuffer,
  options?: { minPauseSec: number; minSceneDurationSec: number },
) => Array<{
  start: number;
  end: number;
  duration: number;
  speechStart: number;
  speechEnd: number;
}>;
let getSceneScriptText: (
  captions: Array<{ start: number; end: number; text: string }>,
  sceneStart: number,
  sceneEnd: number,
  script?: string,
  sceneIndex?: number,
  totalScenes?: number,
) => string;
let normalizeAudioSegment: (
  start: number,
  end: number,
  duration: number,
) => { start: number; end: number; duration: number } | null;
let buildAudioSyncedCaptions: (
  script: string,
  buffer: AudioBuffer | null,
  duration: number,
  maxChars: number,
  options: {
    minSilenceSec?: number;
    sceneRanges: Array<{
      start: number;
      end: number;
      speechStart: number;
      speechEnd: number;
    }>;
  },
) => {
  captions: Array<{ start: number; end: number; text: string }>;
  pausesCount: number;
};
let alignScriptToScenes: (
  script: string,
  sceneRanges: Array<{
    start: number;
    end: number;
    speechStart: number;
    speechEnd: number;
  }>,
) => string[];
let formatTime: (seconds: number, ms?: boolean) => string;
let clampVideoTrimStart: (
  sourceDuration: number,
  sceneDuration: number,
  trimStart: number,
) => number;
let videoSourceTime: (
  sourceDuration: number,
  trimStart: number,
  local: number,
  sceneDuration?: number,
) => number;
let fillEmptyMediaSlotsInOrder: <T extends { isPlaceholder?: boolean }>(
  slots: readonly T[],
  media: readonly T[],
) => T[];
let buildSceneFramePlan: (
  scenes: Array<{ start: number; end: number }> | null,
  mediaCount: number,
  duration: number,
  fps: number,
) => Array<{ startFrame: number; endFrame: number; frames: number; duration: number }>;

before(async () => {
  vite = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ detectScenesFromAudio, getSceneScriptText, clampVideoTrimStart, videoSourceTime } =
    await vite.ssrLoadModule("/src/lib/video/scenes.ts"));
  ({ buildAudioSyncedCaptions, alignScriptToScenes } = await vite.ssrLoadModule(
    "/src/lib/video/audioSync.ts",
  ));
  ({ normalizeAudioSegment } = await vite.ssrLoadModule("/src/lib/video/audio.ts"));
  ({ formatTime } = await vite.ssrLoadModule("/src/lib/video/captions.ts"));
  ({ buildSceneFramePlan } = await vite.ssrLoadModule("/src/lib/video/sceneFrames.ts"));
  ({ fillEmptyMediaSlotsInOrder } = await vite.ssrLoadModule("/src/lib/video/types.ts"));
});

after(async () => {
  await vite.close();
});

function syntheticNarration(
  duration: number,
  speechRanges: Array<[start: number, end: number]>,
  channelValues: number[] = [0.5],
): AudioBuffer {
  const sampleRate = 16_000;
  const length = Math.round(duration * sampleRate);
  const channels = channelValues.map((value) => {
    const data = new Float32Array(length);
    for (const [start, end] of speechRanges) {
      data.fill(value, Math.round(start * sampleRate), Math.round(end * sampleRate));
    }
    return data;
  });
  const buffer: AudioBufferLike = {
    duration,
    sampleRate,
    numberOfChannels: channels.length,
    length,
    getChannelData: (channel) => channels[channel]!,
  };
  return buffer as AudioBuffer;
}

test("quebra a narração nas pausas e mantém cenas contíguas", () => {
  const buffer = syntheticNarration(9, [
    [0.5, 2],
    [3, 5],
    [6, 8],
  ]);
  const scenes = detectScenesFromAudio(buffer, {
    minPauseSec: 0.7,
    minSceneDurationSec: 1,
  });

  assert.equal(scenes.length, 3);
  assert.equal(scenes[0]!.start, 0);
  assert.equal(scenes.at(-1)!.end, 9);

  for (const [index, scene] of scenes.entries()) {
    assert.equal(scene.duration, Number((scene.end - scene.start).toFixed(2)));
    assert.ok(scene.speechStart >= scene.start);
    assert.ok(scene.speechEnd <= scene.end);
    assert.ok(scene.speechEnd > scene.speechStart);
    if (index > 0) assert.equal(scenes[index - 1]!.end, scene.start);
  }

  assert.ok(scenes[0]!.end > 2 && scenes[0]!.end < 3);
  assert.ok(scenes[1]!.end > 5 && scenes[1]!.end < 6);
});

test("usa 0,45s como pausa mínima padrão para novas cenas", () => {
  const buffer = syntheticNarration(6, [
    [0.2, 2],
    [2.6, 5.8],
  ]);

  const scenes = detectScenesFromAudio(buffer);

  assert.equal(scenes.length, 2);
  assert.ok(scenes[0]!.end > 2 && scenes[0]!.end < 2.6);
});

test("mantém cada trecho do roteiro dentro da respectiva cena de fala", () => {
  const buffer = syntheticNarration(8, [
    [0.2, 2.2],
    [2.8, 4.8],
    [5.4, 7.4],
  ]);
  const scenes = detectScenesFromAudio(buffer, {
    minPauseSec: 0.45,
    minSceneDurationSec: 1,
  });
  const script = "Primeira parte. Segunda parte. Terceira parte.";

  const { captions } = buildAudioSyncedCaptions(script, buffer, 8, 90, {
    minSilenceSec: 0.45,
    sceneRanges: scenes,
  });
  const sceneTexts = scenes.map((scene, index) =>
    getSceneScriptText(captions, scene.speechStart, scene.speechEnd, script, index, scenes.length),
  );

  assert.deepEqual(sceneTexts, ["Primeira parte.", "Segunda parte.", "Terceira parte."]);
  assert.equal(sceneTexts.join(" "), script);

  for (const caption of captions) {
    const owners = scenes.filter(
      (scene) => caption.start >= scene.speechStart && caption.end <= scene.speechEnd,
    );
    assert.equal(owners.length, 1);
  }
});

test("não adianta a frase seguinte ao alinhar cenas de durações diferentes", () => {
  const script =
    "Primeiro ponto muito detalhado e importante. Segundo ponto breve. Terceiro ponto com explicação adicional. Quarto ponto essencial. O valor da embalagem também precisa entrar na conta. Comparar apenas preços pode enganar.";
  const speechDurations = [6.052, 2.389, 5.643, 2.408, 9.906];
  let cursor = 0;
  const sceneRanges = speechDurations.map((duration) => {
    const range = {
      start: cursor,
      end: cursor + duration,
      speechStart: cursor,
      speechEnd: cursor + duration,
    };
    cursor += duration + 0.5;
    return range;
  });

  const sceneTexts = alignScriptToScenes(script, sceneRanges);

  assert.equal(sceneTexts[3], "Quarto ponto essencial.");
  assert.match(sceneTexts[4] ?? "", /^O valor da embalagem também/);
  assert.match(sceneTexts[4] ?? "", /Comparar apenas preços/);
});

test("não cancela fala estéreo com canais em polaridade oposta", () => {
  const buffer = syntheticNarration(
    5,
    [
      [0.4, 1.5],
      [2.5, 4.5],
    ],
    [0.5, -0.5],
  );
  const scenes = detectScenesFromAudio(buffer, {
    minPauseSec: 0.7,
    minSceneDurationSec: 0.5,
  });

  assert.equal(scenes.length, 2);
  assert.ok(scenes[0]!.speechStart > 0);
  assert.ok(scenes[1]!.speechEnd < 5);
});

test("mantém respirações menores que a pausa mínima dentro da mesma cena", () => {
  const buffer = syntheticNarration(4, [
    [0.2, 1.5],
    [2, 3.7],
  ]);
  const scenes = detectScenesFromAudio(buffer, {
    minPauseSec: 0.7,
    minSceneDurationSec: 0.5,
  });

  assert.equal(scenes.length, 1);
  assert.equal(scenes[0]!.start, 0);
  assert.equal(scenes[0]!.end, 4);
});

test("normaliza o intervalo reproduzido para a duração do AudioBuffer", () => {
  assert.deepEqual(normalizeAudioSegment(-2, 12, 10), {
    start: 0,
    end: 10,
    duration: 10,
  });
  assert.deepEqual(normalizeAudioSegment(2.25, 4.75, 10), {
    start: 2.25,
    end: 4.75,
    duration: 2.5,
  });
  assert.equal(normalizeAudioSegment(5, 4, 10), null);
  assert.equal(normalizeAudioSegment(Number.NaN, 4, 10), null);
});

test("atribui um bloco de roteiro a apenas um lado da fronteira", () => {
  const captions = [{ start: 1, end: 3, text: "Trecho único" }];

  assert.equal(getSceneScriptText(captions, 0, 2, "", 0, 2), "");
  assert.equal(getSceneScriptText(captions, 2, 4, "", 1, 2), "Trecho único");
});

test("normaliza o arredondamento do relógio ao completar um segundo", () => {
  assert.equal(formatTime(9.9996, true), "00:10,000");
  assert.equal(formatTime(59.9996, true), "01:00,000");
  assert.equal(formatTime(Number.NaN, true), "00:00,000");
});

test("limita o ponto de entrada ao trecho de vídeo que cabe inteiro na cena", () => {
  assert.equal(clampVideoTrimStart(15, 10, 8), 5);
  assert.equal(clampVideoTrimStart(15, 10, -2), 0);
  assert.equal(clampVideoTrimStart(8, 10, 3), 0);
  assert.equal(clampVideoTrimStart(Number.NaN, 10, 3), 0);

  // Mesmo que um projeto antigo tenha salvo 14 s, uma cena de 10 s usa no
  // máximo 5 s como entrada e termina no fim real do clipe (15 s).
  assert.equal(videoSourceTime(15, 14, 9.9, 10), 14.9);
});

test("preenche um card excluído sem deslocar as cenas seguintes", () => {
  const slots = [
    { name: "Cena 7" },
    { name: "Cena 8 vazia", isPlaceholder: true },
    { name: "Cena 9" },
    { name: "Cena 10" },
  ];
  const result = fillEmptyMediaSlotsInOrder(slots, [{ name: "Nova Cena 8" }]);

  assert.deepEqual(
    result.map((item) => item.name),
    ["Cena 7", "Nova Cena 8", "Cena 9", "Cena 10"],
  );
  assert.equal(slots[1]!.isPlaceholder, true);
});

test("mantém a mídia individual antes de todas as mídias adicionadas no lote seguinte", () => {
  const individual = { name: "individual" };
  const batch = [{ name: "lote-1" }, { name: "lote-2" }, { name: "lote-3" }];

  const afterIndividual = fillEmptyMediaSlotsInOrder([], [individual]);
  const afterBatch = fillEmptyMediaSlotsInOrder(afterIndividual, batch);

  assert.deepEqual(
    afterBatch.map((item) => item.name),
    ["individual", "lote-1", "lote-2", "lote-3"],
  );
});

test("limita cada mídia ao fim declarado da respectiva cena", () => {
  const plan = buildSceneFramePlan(
    [
      { start: 0, end: 4 },
      { start: 4, end: 12 },
      { start: 12, end: 17 },
    ],
    3,
    17,
    30,
  );

  assert.deepEqual(
    plan.map(({ startFrame, endFrame, frames, duration }) => ({
      startFrame,
      endFrame,
      frames,
      duration,
    })),
    [
      { startFrame: 0, endFrame: 120, frames: 120, duration: 4 },
      { startFrame: 120, endFrame: 360, frames: 240, duration: 8 },
      { startFrame: 360, endFrame: 510, frames: 150, duration: 5 },
    ],
  );
});

test("rejeita lacunas que fariam uma cena invadir a próxima", () => {
  assert.throws(
    () =>
      buildSceneFramePlan(
        [
          { start: 0, end: 8 },
          { start: 12, end: 20 },
        ],
        2,
        20,
        30,
      ),
    /não começa onde a cena anterior termina|nao comeca onde a cena anterior termina/,
  );
});

test("arredonda fronteiras cumulativamente sem aumentar cenas intermediárias", () => {
  const plan = buildSceneFramePlan(
    [
      { start: 0, end: 1.015 },
      { start: 1.015, end: 2.025 },
      { start: 2.025, end: 3.04 },
    ],
    3,
    3.04,
    30,
  );

  assert.deepEqual(
    plan.map((scene) => scene.frames),
    [30, 31, 31],
  );
  assert.equal(
    plan.reduce((total, scene) => total + scene.frames, 0),
    Math.ceil(3.04 * 30),
  );
});
