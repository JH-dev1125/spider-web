// Pure charge tracker shared by keyboard and hand input. No window/document.
// One held aim per side ('L' = left hand, 'R' = right hand, 'C' = overhead): holding Q and E holds both.
export function createChargeTracker() {
  const aims = new Map(); // side -> {side, level, t0}, in press order (the last entry is the most recent)
  const shot = (a, t) => ({ side: a.side, level: a.level, heldSec: t - a.t0 });
  return {
    // A press on a side that is already held replaces that side's aim only.
    press(side, level, t) { aims.delete(side); aims.set(side, { side, level, t0: t }); },
    // Release side's aim. level must match unless null (a superseded key's keyup on the same side is ignored).
    // side null = release every aim; returns the most recent one's shot. null = nothing was held there.
    release(side, level, t) {
      if (side === null) {
        const last = [...aims.values()].at(-1);
        aims.clear();
        return last ? shot(last, t) : null;
      }
      const a = aims.get(side);
      if (!a || (level !== null && level !== a.level)) return null;
      aims.delete(side);
      return shot(a, t);
    },
    cancel() { aims.clear(); },
    // side's aim, or the most recent aim when side is omitted; null if none.
    state(t, side) {
      const a = side ? aims.get(side) : [...aims.values()].at(-1);
      return a ? shot(a, t) : null;
    },
  };
}
