// RBJ biquad magnitude response. This is a requested-response preview only.
export function filterDb(filter, frequency, sampleRate = 48000) {
  const { kind, gain, q, frequency: centre } = filter;
  if (![gain, q, centre, frequency].every(Number.isFinite) || q <= 0 || centre < 20 || centre > 20000) return NaN;
  const a = 10 ** (gain / 40), w = 2 * Math.PI * centre / sampleRate;
  const c = Math.cos(w), alpha = Math.sin(w) / (2 * q), beta = 2 * Math.sqrt(a) * alpha;
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'PK') {
    [b0, b1, b2] = [1 + alpha * a, -2 * c, 1 - alpha * a];
    [a0, a1, a2] = [1 + alpha / a, -2 * c, 1 - alpha / a];
  } else if (kind === 'LS') {
    [b0, b1, b2] = [a * ((a + 1) - (a - 1) * c + beta), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - beta)];
    [a0, a1, a2] = [(a + 1) + (a - 1) * c + beta, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - beta];
  } else if (kind === 'HS') {
    [b0, b1, b2] = [a * ((a + 1) + (a - 1) * c + beta), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - beta)];
    [a0, a1, a2] = [(a + 1) - (a - 1) * c + beta, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - beta];
  } else return NaN;
  const angle = 2 * Math.PI * frequency / sampleRate;
  const power = (x, y, z) => (x + y * Math.cos(angle) + z * Math.cos(2 * angle)) ** 2 + (y * Math.sin(angle) + z * Math.sin(2 * angle)) ** 2;
  return 10 * Math.log10(power(b0, b1, b2) / power(a0, a1, a2));
}

export function responseDb(filters, preamp, frequency) {
  return filters.reduce((sum, filter) => sum + filterDb(filter, frequency), preamp);
}
