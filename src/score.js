// Best distance, persisted when storage works. Future leaderboard hook: swap this module only.
const KEY = 'webrunner.best';

export function createScore(storage) {
  let best = 0;
  try {
    const v = Number(storage.getItem(KEY));
    if (Number.isFinite(v) && v > 0) best = v;
  } catch { /* no storage: memory only */ }
  return {
    best: () => best,
    submit(distance) {
      if (!(distance > best)) return false;
      best = distance;
      try { storage.setItem(KEY, String(distance)); } catch { /* memory only */ }
      return true;
    },
  };
}
