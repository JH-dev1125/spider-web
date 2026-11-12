import { CFG } from './config.js';

// onShot(action) is optional: {type:'press', side, level} on keydown (fire at once),
// {type:'release', ...shot} on keyup of the active aim key, {type:'release'} on blur (let go of the rope).
export function attachKeyboard(target, tracker, now, onShot = () => {}) {
  const down = (e) => {
    const k = CFG.keys[e.code];
    if (!k || e.repeat) return;
    tracker.press(k[0], k[1], now());
    onShot({ type: 'press', side: k[0], level: k[1] });
  };
  const up = (e) => {
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
