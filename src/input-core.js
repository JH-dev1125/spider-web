// Pure charge tracker shared by keyboard and hand input. No window/document.
export function createChargeTracker() {
  let aim = null; // {side, level, t0}
  return {
    press(side, level, t) { aim = { side, level, t0: t }; },
    move(side, level) { if (aim) { aim.side = side; aim.level = level; } },
    release(side, level, t) {
      if (!aim) return null;
      if (side !== null && (side !== aim.side || level !== aim.level)) return null;
      const shot = { side: aim.side, level: aim.level, heldSec: t - aim.t0 };
      aim = null;
      return shot;
    },
    cancel() { aim = null; },
    state(t) { return aim && { side: aim.side, level: aim.level, heldSec: t - aim.t0 }; },
  };
}
