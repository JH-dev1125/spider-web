import { CFG } from './config.js';

// onRelease(shot) is optional: receives the tracker's release result when non-null.
export function attachKeyboard(target, tracker, now, onRelease = () => {}) {
  const down = (e) => {
    const k = CFG.keys[e.code];
    if (k && !e.repeat) tracker.press(k[0], k[1], now());
  };
  const up = (e) => {
    const k = CFG.keys[e.code];
    const shot = k && tracker.release(k[0], k[1], now());
    if (shot) onRelease(shot);
  };
  const blur = () => tracker.cancel();
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', blur);
  };
}
