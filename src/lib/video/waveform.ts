/**
 * Picos de amplitude de um AudioBuffer para desenhar a forma de onda da narração
 * na linha do tempo. Cada posição guarda o pico (0..1) de um pequeno trecho.
 */
export function computeWaveformPeaks(buffer: AudioBuffer, bins: number): Float32Array {
  const safeBins = Math.max(1, Math.floor(bins));
  const peaks = new Float32Array(safeBins);
  const length = buffer.length;
  if (length <= 0) return peaks;

  const samplesPerBin = length / safeBins;
  // Amostragem com passo: o desenho não precisa de todas as amostras e isso mantém
  // áudios de dezenas de minutos rápidos de analisar.
  const stride = Math.max(1, Math.floor(samplesPerBin / 64));
  let loudest = 0;
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex);
    for (let bin = 0; bin < safeBins; bin += 1) {
      const from = Math.floor(bin * samplesPerBin);
      const to = Math.min(length, Math.floor((bin + 1) * samplesPerBin));
      let peak = peaks[bin]!;
      for (let index = from; index < to; index += stride) {
        const value = Math.abs(channel[index] ?? 0);
        if (value > peak) peak = value;
      }
      peaks[bin] = peak;
      if (peak > loudest) loudest = peak;
    }
  }
  // Normaliza para que narrações baixas também fiquem legíveis.
  if (loudest > 0.0001) {
    for (let bin = 0; bin < safeBins; bin += 1) peaks[bin] = Math.min(1, peaks[bin]! / loudest);
  }
  return peaks;
}
