// The street frame: which street the hero travels and which way. Pure math, no physics or three.js.
// street = { axis: 'z' | 'x' (the travel axis), lat: the other axis, dir: +1 | -1 (along axis), line: grid index,
//            centre: the centreline's coordinate on lat (x of a z-street, z of an x-street) }.
// Local frame: x = right of travel, y = up, z = ahead along the street (the old corridor frame).

export const makeStreet = (axis, line, dir, centre) => ({ axis, lat: axis === 'z' ? 'x' : 'z', line, dir, centre });

// Unit heading and right vectors in world x/z. Heading +z has right +x; a right turn from +z heads +x, right -z.
export const heading = (st) => (st.axis === 'z' ? { x: 0, z: st.dir } : { x: st.dir, z: 0 });
export const right = (st) => { const h = heading(st); return { x: h.z, z: -h.x }; };

// World point/vector <-> local. Points are relative to the centreline (local x = 0 on it).
export const toWorldVec = (st, v) => {
  const h = heading(st), r = right(st);
  return { x: r.x * v.x + h.x * v.z, y: v.y, z: r.z * v.x + h.z * v.z };
};
export const toLocalVec = (st, v) => {
  const h = heading(st), r = right(st);
  return { x: r.x * v.x + r.z * v.z, y: v.y, z: h.x * v.x + h.z * v.z };
};
const origin = (st) => (st.axis === 'z' ? { x: st.centre, y: 0, z: 0 } : { x: 0, y: 0, z: st.centre });
export const toLocal = (st, p) => { const o = origin(st); return toLocalVec(st, { x: p.x - o.x, y: p.y, z: p.z - o.z }); };
export const toWorld = (st, l) => { const o = origin(st), v = toWorldVec(st, l); return { x: v.x + o.x, y: v.y, z: v.z + o.z }; };

// Yaw of the heading (radians, 0 = +z, +pi/2 = +x).
export const yawOf = (st) => { const h = heading(st); return Math.atan2(h.x, h.z); };

