// Luck check: resample daily returns with replacement (seeded, so reruns match) and count how often the
// compounded total ends above zero. Under 80% = "could be luck".
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function pAboveZero(daily, n = 5000, seed = 7) {
  if (!daily.length) return 0; const R = rng(seed); let pos = 0;
  for (let k = 0; k < n; k++) { let g = 0; for (let i = 0; i < daily.length; i++) g += Math.log(1 + daily[Math.floor(R() * daily.length)]); if (g > 0) pos++; }
  return pos / n;
}
