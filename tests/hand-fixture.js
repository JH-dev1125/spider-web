// Synthetic 3D hand (21 MediaPipe landmarks) in mirrored screen space: x right, y down, z toward the
// camera is negative. Canonical pose: a right hand, palm facing the camera, fingers up, about 0.25 tall.
// ext lists extended fingers: i(ndex) m(iddle) r(ing) p(inky); the rest fold onto the palm (toward the camera).
// opts: curl {i,m,r,p: 0 straight .. 1 folded} overrides ext; thumb 'out'|'in'; left (mirror image of the
// right hand); yaw (about y, 180 = back of the hand to the camera), pitch (about x), roll (in-plane) in degrees;
// scale (1 = canonical size); zScale (MediaPipe often underestimates depth).
const MCP = { i: [-0.035, -0.13], m: [-0.01, -0.135], r: [0.015, -0.13], p: [0.038, -0.115] };
const LEN = { i: [0.05, 0.03, 0.025], m: [0.055, 0.035, 0.027], r: [0.05, 0.032, 0.025], p: [0.04, 0.025, 0.022] };
const IDX = { i: 5, m: 9, r: 13, p: 17 };
const FOLD = [70, 100, 60]; // MCP, PIP, DIP flexion in degrees when fully folded
const THUMB = {
  out: [[-0.04, -0.03, -0.01], [-0.07, -0.06, -0.015], [-0.09, -0.085, -0.02], [-0.105, -0.105, -0.02]],
  in: [[-0.035, -0.03, -0.015], [-0.05, -0.065, -0.03], [-0.035, -0.09, -0.045], [-0.01, -0.1, -0.05]],
};
const rad = (d) => d * Math.PI / 180;

export function hand(wx, wy, ext, opts = {}) {
  const { curl = {}, thumb = 'out', left = false, yaw = 0, pitch = 0, roll = 0, scale = 1, zScale = 1 } = opts;
  const local = Array(21);
  local[0] = [0, 0, 0];
  THUMB[thumb].forEach((p, k) => { local[1 + k] = p; });
  for (const f of 'imrp') {
    const c = curl[f] ?? (ext.includes(f) ? 0.05 : 1);
    let [x, y, z] = [...MCP[f], 0], th = 0;
    local[IDX[f]] = [x, y, z];
    LEN[f].forEach((len, k) => { // flexion turns the finger from -y toward -z (the camera, palm facing it)
      th += rad(FOLD[k] * c);
      y -= len * Math.cos(th); z -= len * Math.sin(th);
      local[IDX[f] + 1 + k] = [x, y, z];
    });
  }
  const [cy, sy, cp, sp, cr, sr] = [yaw, yaw, pitch, pitch, roll, roll].map((d, k) => (k % 2 ? Math.sin : Math.cos)(rad(d)));
  return local.map(([x, y, z]) => {
    if (left) x = -x;
    [x, z] = [cy * x + sy * z, -sy * x + cy * z]; // yaw
    [y, z] = [cp * y - sp * z, sp * y + cp * z]; // pitch
    [x, y] = [cr * x - sr * y, sr * x + cr * y]; // roll
    return { x: wx + x * scale, y: wy + y * scale, z: z * scale * zScale };
  });
}
export const SHOOT = 'ip', FIST = '', OPEN = 'imrp', NONE = 'im';
