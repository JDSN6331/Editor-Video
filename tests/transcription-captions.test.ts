import assert from "node:assert/strict";
import test from "node:test";
import { captionsFromTranscription } from "../src/lib/video/transcription.ts";

test("legendas transcritas preservam texto e timestamps reais", () => {
  const captions = captionsFromTranscription(
    [
      { text: "Olá", start: 0.12, end: 0.45 },
      { text: ",", start: 0.45, end: 0.5 },
      { text: "mundo", start: 0.55, end: 1.02 },
      { text: "!", start: 1.02, end: 1.08 },
    ],
    90,
  );

  assert.equal(captions.length, 1);
  assert.equal(captions[0]?.text, "Olá, mundo!");
  assert.equal(captions[0]?.start, 0.12);
  assert.equal(captions[0]?.end, 1.08);
  assert.deepEqual(captions[0]?.words?.[2], { text: "mundo", start: 0.55, end: 1.02 });
});

test("pausas reais dividem blocos sem alterar a ordem das palavras", () => {
  const captions = captionsFromTranscription(
    [
      { text: "Esta", start: 0, end: 0.3 },
      { text: "é", start: 0.31, end: 0.4 },
      { text: "a", start: 0.41, end: 0.5 },
      { text: "primeira", start: 0.51, end: 0.9 },
      { text: "frase.", start: 0.91, end: 1.25 },
      { text: "Esta", start: 2.4, end: 2.7 },
      { text: "é", start: 2.71, end: 2.8 },
      { text: "a", start: 2.81, end: 2.9 },
      { text: "segunda.", start: 2.91, end: 3.4 },
    ],
    90,
  );

  assert.deepEqual(
    captions.map((caption) => caption.text),
    ["Esta é a primeira frase.", "Esta é a segunda."],
  );
  assert.equal(captions[1]?.start, 2.4);
});

test("limite de caracteres cria blocos contíguos", () => {
  const captions = captionsFromTranscription(
    [
      { text: "um", start: 0, end: 0.2 },
      { text: "dois", start: 0.2, end: 0.4 },
      { text: "três", start: 0.4, end: 0.6 },
      { text: "quatro", start: 0.6, end: 0.8 },
    ],
    10,
  );

  assert.deepEqual(
    captions.map((caption) => caption.text),
    ["um dois", "três", "quatro"],
  );
});
