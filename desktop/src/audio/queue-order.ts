export type RepeatMode = 'off' | 'all' | 'one';

/** Fisher–Yates, keeping the selected track at the start of a new shuffled queue. */
export function shuffledQueue(ids: string[], anchor?: string | null): string[] {
  const result = [...new Set(ids)];
  const index = anchor ? result.indexOf(anchor) : -1;
  const start = index >= 0 ? 1 : 0;
  if (index >= 0) result.unshift(...result.splice(index, 1));
  for (let i = result.length - 1; i > start; --i) {
    const random = new Uint32Array(1); crypto.getRandomValues(random);
    const j = start + random[0] % (i - start + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
