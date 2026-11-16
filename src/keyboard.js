import { CFG } from './config.js';

// onShot(action) is optional: {type:'press', side, level} on keydown (fire at once; each side holds its own key,
// so Q and E held together are two presses), {type:'release', side, level, heldSec} on keyup of that side's current
// key (lets go of that side's rope only), {type:'release'} without a side on blur (lets go of every rope),
// {type:'zip'} on keydown of CFG.zipKey: one slingshot per press, nothing on keyup (main.js drops it outside play,
// where Space starts).
export function attachKeyboard(target, tracker, now, onShot = () => {}) {
  const down = (e) => {
    if (e.code === CFG.zipKey) { if (!e.repeat) onShot({ type: 'zip' }); return; }
    const k = CFG.keys[e.code];
    if (!k || e.repeat) return;
    tracker.press(k[0], k[1], now());
    onShot({ type: 'press', side: k[0], level: k[1] });
  };
  const up = (e) => {
    if (e.code === CFG.zipKey) return;
    const k = CFG.keys[e.code];
    const shot = k && tracker.release(k[0], k[1], now());
    if (shot) onShot({ type: 'release', ...shot });
  };
  const blur = () => { tracker.cancel(); onShot({ type: 'release' }); };
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', blur);
  };
}
