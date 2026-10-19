// Synthetic swing generator + assertions for analysis.js.
import { SwingCoach } from '../web/analysis.js';

const smooth = (u) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
// keyframes: [{t, ...values}] -> interpolated values at time t
function interp(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i], u = smooth((t - a.t) / (b.t - a.t));
      const o = {};
      for (const k of Object.keys(b)) o[k] = typeof b[k] === 'number' ? a[k] + (b[k] - a[k]) * u : b[k];
      return o;
    }
  }
  return keys[keys.length - 1];
}

// Body pose from: yaw (deg), knee angle (deg), dominant wrist & non-dom wrist in body coords
// body coords: r = toward right (dominant for RH), f = forward, y = down.
function pose(k) {
  const th = (k.yaw * Math.PI) / 180;
  const R = { x: Math.cos(th), z: Math.sin(th) };      // body right
  const F = { x: -Math.sin(th), z: Math.cos(th) };     // body forward
  const P = (r, f, y) => ({ x: R.x * r + F.x * f, y, z: R.z * r + F.z * f, visibility: 0.99 });
  const hth = (k.hipYaw * Math.PI) / 180;
  const HR = { x: Math.cos(hth), z: Math.sin(hth) };
  const H = (r, y) => ({ x: HR.x * r, y, z: HR.z * r, visibility: 0.99 });
  const w = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.99 }));
  const kneeBend = (180 - k.knee) * Math.PI / 180; // shank tilt
  w[0] = P(0, 0.05, -0.75 + k.headBob);
  w[11] = P(-0.2, 0, -0.5 - k.lift / 2); w[12] = P(0.2, 0, -0.5 + k.lift / 2);
  w[23] = H(-0.15, 0); w[24] = H(0.15, 0);
  for (const [kn, an, sx] of [[25, 27, -0.15], [26, 28, 0.15]]) {
    const hip = H(sx, 0), c = Math.cos(kneeBend / 2), s = Math.sin(kneeBend / 2);
    w[kn] = { x: hip.x + F.x * 0.42 * s, y: 0.42 * c, z: hip.z + F.z * 0.42 * s, visibility: 0.99 };
    w[an] = { x: hip.x, y: 0.84 * c, z: hip.z, visibility: 0.99 };
  }
  w[16] = P(k.dr, k.df, k.dy); w[15] = P(k.nr, k.nf, k.ny);
  // elbows: between shoulder and wrist, pushed outward/down by `bend`
  const el = (sh, wr, out) => ({ x: (sh.x + wr.x) / 2 + out * R.x, y: (sh.y + wr.y) / 2 + k.bend, z: (sh.z + wr.z) / 2 + out * R.z, visibility: 0.99 });
  w[14] = el(w[12], w[16], 0.05); w[13] = el(w[11], w[15], -0.05);
  const n = w.map((p) => ({ x: 0.5 + p.x * 0.25, y: 0.55 + p.y * 0.25 + k.bounce, z: 0, visibility: 0.99 }));
  return { w, n };
}

const base = { yaw: 0, hipYaw: 0, knee: 170, lift: 0, headBob: 0, bounce: 0, bend: 0.03, dr: 0.25, df: 0.35, dy: -0.05, nr: -0.1, nf: 0.35, ny: -0.05 };
const kf = (t, o) => ({ ...base, t, ...o });

const SCRIPTS = {
  goodForehand: [
    kf(0), kf(0.4, { knee: 168 }),
    kf(0.9, { yaw: -85, hipYaw: -45, knee: 140, dr: 0.35, df: -0.35, dy: -0.15, nr: -0.1, nf: 0.45 }),
    kf(1.1, { yaw: -40, hipYaw: -20, knee: 150, dr: 0.45, df: -0.1, dy: 0.0 }),
    kf(1.25, { yaw: 0, hipYaw: 0, knee: 160, dr: 0.38, df: 0.4, dy: -0.15, bend: 0.0 }),
    kf(1.45, { yaw: 20, hipYaw: 10, knee: 165, dr: -0.25, df: 0.15, dy: -0.65 }),
    kf(2.2, { yaw: 20, hipYaw: 10, knee: 168, dr: -0.25, df: 0.15, dy: -0.65 }),
  ],
  badForehand: [ // arm-only swing: no turn, short takeback, cramped, no finish
    kf(0), kf(0.9, { knee: 172, dr: 0.3, df: 0.0, dy: -0.1 }),
    kf(1.15, { knee: 172, dr: 0.18, df: 0.05, dy: -0.15, bend: 0.12 }),
    kf(1.24, { knee: 172, dr: 0.1, df: 0.3, dy: -0.15, bend: 0.12 }),
    kf(1.45, { knee: 172, dr: 0.12, df: 0.35, dy: -0.15, bend: 0.12 }),
    kf(2.2, { knee: 172, dr: 0.12, df: 0.35, dy: -0.15, bend: 0.12 }),
  ],
  goodBackhand2: [
    kf(0),
    kf(0.9, { yaw: 85, hipYaw: 45, knee: 140, dr: -0.4, df: -0.3, dy: -0.1, nr: -0.45, nf: -0.3, ny: -0.1 }),
    kf(1.1, { yaw: 40, hipYaw: 20, knee: 150, dr: -0.45, df: -0.05, dy: 0.0, nr: -0.5, nf: -0.05, ny: 0.0 }),
    kf(1.25, { yaw: 0, knee: 160, dr: -0.3, df: 0.45, dy: -0.15, nr: -0.32, nf: 0.4, ny: -0.15, bend: 0.0 }),
    kf(1.45, { yaw: -20, knee: 165, dr: 0.3, df: 0.1, dy: -0.65, nr: 0.25, nf: 0.1, ny: -0.62 }),
    kf(2.2, { yaw: -20, knee: 165, dr: 0.3, df: 0.1, dy: -0.65, nr: 0.25, nf: 0.1, ny: -0.62 }),
  ],
  goodServe: [
    kf(0, { yaw: -60, hipYaw: -50, dr: 0.2, df: 0.3, dy: 0.0, nr: -0.1, nf: 0.3, ny: 0.0 }),
    kf(1.0, { yaw: -70, hipYaw: -55, knee: 140, lift: 0.12, dr: 0.45, df: -0.2, dy: -0.55, nr: -0.15, nf: 0.2, ny: -1.05 }),
    kf(1.35, { yaw: -60, hipYaw: -50, knee: 145, lift: 0.1, dr: 0.35, df: -0.45, dy: -0.2, nr: -0.1, nf: 0.2, ny: -0.6 }),
    kf(1.55, { yaw: -10, hipYaw: -10, knee: 175, lift: -0.05, dr: 0.15, df: 0.25, dy: -1.25, bend: -0.02, nr: -0.2, nf: 0.1, ny: -0.1 }),
    kf(1.85, { yaw: 20, knee: 170, dr: -0.25, df: 0.25, dy: 0.15, nr: -0.2, nf: 0, ny: 0.0 }),
    kf(2.6, { yaw: 20, knee: 170, dr: -0.25, df: 0.25, dy: 0.15, nr: -0.2, nf: 0, ny: 0.0 }),
  ],
  goodVolley: [
    kf(0, { dr: 0.25, df: 0.35, dy: -0.15 }),
    kf(0.3, { bounce: -0.04, knee: 160 }), kf(0.5, { bounce: 0.02, knee: 145 }),
    kf(0.9, { yaw: -25, knee: 145, dr: 0.38, df: 0.2, dy: -0.2 }),
    kf(1.05, { yaw: -10, knee: 148, dr: 0.33, df: 0.5, dy: -0.2 }),
    kf(1.2, { yaw: -5, knee: 150, dr: 0.3, df: 0.6, dy: -0.2 }),
    kf(2.0, { yaw: -5, knee: 150, dr: 0.3, df: 0.6, dy: -0.2 }),
  ],
};

function run(name, opts) {
  const coach = new SwingCoach(opts);
  const keys = SCRIPTS[name];
  const results = [];
  let maxV = 0;
  for (let t = 0; t <= keys[keys.length - 1].t; t += 1 / 30) {
    const k = interp(keys, t);
    const r = coach.push({ t, ...pose(k) });
    maxV = Math.max(maxV, coach.speed);
    if (r) results.push(r);
  }
  console.log(`\n== ${name} ${JSON.stringify(opts)}  peak wrist speed ${maxV.toFixed(2)} m/s`);
  for (const r of results) {
    if (r.skipped) { console.log('  skipped:', r.note); continue; }
    console.log(`  ${r.label}  overall ${r.overall}  tip[${r.tip.kind}] ${r.tip.text}`);
    for (const m of r.metrics) console.log(`    ${m.status.padEnd(4)} ${String(m.score).padStart(3)}  ${m.label}  ${m.value != null ? m.value.toFixed(2) + (m.unit || '') : ''}`);
  }
  return results;
}

const out = {
  gf: run('goodForehand', { stroke: 'forehand' }),
  gfa: run('goodForehand', { stroke: 'auto' }),
  bf: run('badForehand', { stroke: 'forehand' }),
  gb: run('goodBackhand2', { stroke: 'auto' }),
  gbAsFh: run('goodBackhand2', { stroke: 'forehand' }),
  gs: run('goodServe', { stroke: 'serve' }),
  gsa: run('goodServe', { stroke: 'auto' }),
  gv: run('goodVolley', { stroke: 'volley' }),
};
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1; };
console.log('');
check(out.gf.length === 1 && out.gf[0].overall >= 85, 'good forehand scores high');
check(out.gfa[0]?.stroke === 'forehand', 'auto mode classifies forehand');
check(out.bf.length === 1 && out.bf[0].overall < 60 && out.bf[0].tip.kind === 'fix', 'arm-only forehand scores low with a fix tip');
check(out.gb[0]?.stroke === 'backhand' && out.gb[0].overall >= 85, 'auto mode: good two-handed backhand');
check(out.gbAsFh[0]?.skipped, 'backhand skipped when practising forehand');
check(out.gs[0]?.overall >= 85, 'good serve scores high');
check(out.gsa[0]?.stroke === 'serve', 'auto mode classifies serve');
check(out.gv[0]?.overall >= 85, 'good volley scores high');
