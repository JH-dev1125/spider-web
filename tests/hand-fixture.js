// Synthetic hand: 21 points at the wrist; each finger's PIP 0.1 above it, tip 0.2 (extended) or 0.05 (folded).
// ext lists extended fingers: i(ndex) m(iddle) r(ing) p(inky).
const FINGERS = { i: [6, 8], m: [10, 12], r: [14, 16], p: [18, 20] };
export function hand(wx, wy, ext) {
  const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
  for (const [f, [pip, tip]] of Object.entries(FINGERS)) {
    lm[pip] = { x: wx, y: wy - 0.1 };
    lm[tip] = { x: wx, y: wy - (ext.includes(f) ? 0.2 : 0.05) };
  }
  return lm;
}
export const SHOOT = 'ip', FIST = '', OPEN = 'imrp', NONE = 'im';
