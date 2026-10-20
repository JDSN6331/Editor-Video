export interface SceneInterval {
  start: number;
  end: number;
}

export interface SceneFrameSegment extends SceneInterval {
  startFrame: number;
  endFrame: number;
  frames: number;
  duration: number;
}

/**
 * Converte a grade temporal em uma grade de quadros sem acumular arredondamento.
 *
 * Os fins declarados pelas cenas sao a fonte de verdade. Isso impede que uma
 * lacuna acidental antes da cena seguinte seja incorporada a cena anterior.
 */
export function buildSceneFramePlan(
  scenes: readonly SceneInterval[] | null,
  mediaCount: number,
  duration: number,
  fps: number,
): SceneFrameSegment[] {
  if (!Number.isInteger(mediaCount) || mediaCount <= 0) {
    throw new Error("A montagem precisa ter ao menos uma midia.");
  }
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error("Duracao ou taxa de quadros invalida para a montagem.");
  }

  const frameTolerance = 0.5 / fps + Number.EPSILON;
  const intervals = scenes
    ? scenes.map((scene) => ({ start: scene.start, end: scene.end }))
    : Array.from({ length: mediaCount }, (_, index) => ({
        start: (index * duration) / mediaCount,
        end: ((index + 1) * duration) / mediaCount,
      }));

  if (intervals.length !== mediaCount) {
    throw new Error(
      `A montagem exige uma midia por trecho da narracao (${mediaCount} midias para ${intervals.length} trechos).`,
    );
  }

  for (let index = 0; index < intervals.length; index += 1) {
    const scene = intervals[index]!;
    if (!Number.isFinite(scene.start) || !Number.isFinite(scene.end) || scene.end <= scene.start) {
      throw new Error(`A cena ${index + 1} possui um intervalo invalido.`);
    }
    const expectedStart = index === 0 ? 0 : intervals[index - 1]!.end;
    if (Math.abs(scene.start - expectedStart) > frameTolerance) {
      throw new Error(
        `A cena ${index + 1} nao comeca onde a cena anterior termina (${scene.start.toFixed(3)}s em vez de ${expectedStart.toFixed(3)}s).`,
      );
    }
  }

  const lastEnd = intervals.at(-1)!.end;
  if (Math.abs(lastEnd - duration) > frameTolerance) {
    throw new Error(
      `A grade de cenas termina em ${lastEnd.toFixed(3)}s, mas a narracao termina em ${duration.toFixed(3)}s.`,
    );
  }

  const boundaryFrames = [0];
  for (let index = 0; index < intervals.length; index += 1) {
    const isLast = index === intervals.length - 1;
    const endFrame = isLast ? Math.ceil(duration * fps) : Math.round(intervals[index]!.end * fps);
    if (endFrame <= boundaryFrames[index]!) {
      throw new Error(`A cena ${index + 1} e curta demais para ${fps} FPS.`);
    }
    boundaryFrames.push(endFrame);
  }

  return intervals.map((scene, index) => {
    const startFrame = boundaryFrames[index]!;
    const endFrame = boundaryFrames[index + 1]!;
    const frames = endFrame - startFrame;
    return {
      start: startFrame / fps,
      end: endFrame / fps,
      startFrame,
      endFrame,
      frames,
      duration: frames / fps,
    };
  });
}
