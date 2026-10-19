// Swing detection and stroke analysis on MediaPipe Pose landmarks.
// Pure module (no DOM) so it can be unit-tested in Node.
//
// Coordinates: MediaPipe world landmarks, meters, origin at hip center,
// x = image right, y = down, z = depth (smaller = closer to camera).
// "Higher" therefore means smaller y.

export const L = {
  nose: 0,
  lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28,
};

export const STROKES = {
  auto: '자동 (포/백/서브)',
  forehand: '포핸드',
  backhand: '백핸드',
  serve: '서브',
  volley: '발리',
  smash: '스매시',
};

// ---------- geometry ----------
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const len = (v) => Math.hypot(v.x, v.y, v.z);
const dotXZ = (a, b) => a.x * b.x + a.z * b.z;
const normXZ = (v) => {
  const m = Math.hypot(v.x, v.z) || 1e-6;
  return { x: v.x / m, y: 0, z: v.z / m };
};
const deg = (r) => (r * 180) / Math.PI;

export function jointAngle(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / ((len(u) * len(v)) || 1e-6);
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}

// Orientation of the segment a->b seen from above (x-z plane), degrees.
export const yawOf = (a, b) => deg(Math.atan2(b.z - a.z, b.x - a.x));
export function angDiff(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// ---------- scoring ----------
// Maps a measurement to 0..100: reaching `good` = 100, `ok` = 70,
// one more ok-to-good step worse = 40, floor 15.
export function scoreOf(value, ok, good) {
  const higher = good >= ok;
  const step = Math.abs(good - ok) || 1e-6;
  const v = higher ? value : -value;
  const g = higher ? good : -good;
  const o = higher ? ok : -ok;
  if (v >= g) return 100;
  if (v >= o) return 70 + (30 * (v - o)) / step;
  return Math.max(15, 70 - (30 * (o - v)) / step);
}
export const statusOf = (s) => (s >= 85 ? 'good' : s >= 65 ? 'ok' : 'bad');

const LEVEL_SCALE = { beginner: 0.85, intermediate: 1, advanced: 1.12 };

// ---------- per-frame helpers ----------
function sides(hand) {
  return hand === 'L'
    ? { D: { sh: L.lSh, el: L.lEl, wr: L.lWr, hip: L.lHip, knee: L.lKnee, ank: L.lAnk },
        N: { sh: L.rSh, el: L.rEl, wr: L.rWr, hip: L.rHip, knee: L.rKnee, ank: L.rAnk } }
    : { D: { sh: L.rSh, el: L.rEl, wr: L.rWr, hip: L.rHip, knee: L.rKnee, ank: L.rAnk },
        N: { sh: L.lSh, el: L.lEl, wr: L.lWr, hip: L.lHip, knee: L.lKnee, ank: L.lAnk } };
}

const vis = (f, i) => (f.w[i].visibility ?? 1);

// Distance of a point toward the non-dominant side of the body (meters),
// measured along the hip line. Positive = across the body.
function lateral(f, s, p) {
  const w = f.w;
  const axis = normXZ(sub(w[s.N.hip], w[s.D.hip]));
  return dotXZ(sub(p, mid(w[s.D.hip], w[s.N.hip])), axis);
}

const shoulderYaw = (f, s) => yawOf(f.w[s.D.sh], f.w[s.N.sh]);
const hipYaw = (f, s) => yawOf(f.w[s.D.hip], f.w[s.N.hip]);

function minKneeAngle(frames) {
  let best = 181, seen = false;
  for (const f of frames) {
    for (const [h, k, a] of [[L.lHip, L.lKnee, L.lAnk], [L.rHip, L.rKnee, L.rAnk]]) {
      if (vis(f, k) < 0.5 || vis(f, a) < 0.4) continue;
      seen = true;
      best = Math.min(best, jointAngle(f.w[h], f.w[k], f.w[a]));
    }
  }
  return seen ? best : null;
}

function imgTorso(f) {
  const n = f.n;
  const sh = mid(n[L.lSh], n[L.rSh]), hp = mid(n[L.lHip], n[L.rHip]);
  return Math.hypot(sh.x - hp.x, sh.y - hp.y) || 0.2;
}

// ---------- the coach ----------
const DEFAULTS = {
  stroke: 'auto',
  hand: 'R',
  backhand: 'two', // 'two' | 'one'
  level: 'intermediate',
  sensitivity: 1, // >1 detects slower swings
};

// Wrist speed (m/s, world coords) that starts a swing, per stroke.
const START_SPEED = { forehand: 2.2, backhand: 2.2, auto: 2.2, serve: 2.6, smash: 2.6, volley: 1.4 };

export class SwingCoach {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.buf = [];
    this.speed = 0;
    this.state = 'idle';
    this.peak = null;
    this.cooldownUntil = -1;
    this.lastTips = [];
  }

  set(opts) {
    Object.assign(this.opts, opts);
    this.reset();
  }

  reset() {
    this.buf = [];
    this.speed = 0;
    this.state = 'idle';
    this.peak = null;
    this.cooldownUntil = -1;
  }

  get threshold() {
    return (START_SPEED[this.opts.stroke] ?? 2.2) / (this.opts.sensitivity || 1);
  }

  // frame: { t: seconds, w: worldLandmarks[33], n: normalizedLandmarks[33] }
  // Returns an analysis result when a swing just finished, else null.
  push(frame) {
    const s = sides(this.opts.hand);
    const prev = this.buf[this.buf.length - 1];
    this.buf.push(frame);
    while (this.buf.length && frame.t - this.buf[0].t > 3.2) this.buf.shift();

    if (prev && frame.t > prev.t && vis(frame, s.D.wr) > 0.3) {
      const dt = frame.t - prev.t;
      let v = len(sub(frame.w[s.D.wr], prev.w[s.D.wr])) / dt;
      if (dt > 0.2) v = 0; // tracking gap
      this.speed = 0.55 * v + 0.45 * this.speed;
    }
    frame.v = this.speed;

    const thr = this.threshold;
    const t = frame.t;
    if (this.state === 'idle') {
      if (t >= this.cooldownUntil && this.speed > thr) {
        this.state = 'swing';
        this.peak = { t, v: this.speed, frame, above: 1 };
      }
      return null;
    }

    // state === 'swing'
    if (this.speed > this.peak.v) Object.assign(this.peak, { t, v: this.speed, frame });
    if (this.speed > thr) this.peak.above++;
    const since = t - this.peak.t;
    const settled = this.speed < thr * 0.35 && since > 0.25;
    if (since > 0.5 || settled) {
      this.state = 'idle';
      this.cooldownUntil = this.peak.t + 0.9;
      if (this.peak.above < 2) return null; // single-frame glitch
      return this.analyze(this.peak.t);
    }
    return null;
  }

  // ---------- analysis ----------
  analyze(peakT) {
    const s = sides(this.opts.hand);
    const isOverheadSel = this.opts.stroke === 'serve' || this.opts.stroke === 'smash';
    const before = isOverheadSel ? 2.2 : 1.4;
    const win = this.buf.filter((f) => f.t >= peakT - before && f.t <= peakT + 0.55);
    if (win.length < 8) return null;
    const pi = win.findIndex((f) => f.t === peakT);
    const pre = win.slice(0, pi + 1);
    const post = win.slice(pi);
    const contact = win[pi];
    const w = contact.w;

    // Swing direction at contact (x-z), used as "forward".
    const a = win[Math.max(0, pi - 2)], b = win[Math.min(win.length - 1, pi + 1)];
    const fwd = normXZ(sub(b.w[s.D.wr], a.w[s.D.wr]));

    const kind = this.classify(win, pi, s);
    let stroke = this.opts.stroke;
    let note = null;
    if (stroke === 'auto') {
      stroke = kind;
    } else if (
      (stroke === 'forehand' && kind === 'backhand') ||
      (stroke === 'backhand' && kind === 'forehand') ||
      ((stroke === 'forehand' || stroke === 'backhand' || stroke === 'volley') && kind === 'serve')
    ) {
      return { skipped: true, stroke: kind, t: peakT, note: `${STROKES[kind]} 동작으로 보여서 건너뛰었어요` };
    } else if (isOverheadSel && kind !== 'serve') {
      return { skipped: true, stroke: kind, t: peakT, note: '머리 위 스윙이 아니어서 건너뛰었어요' };
    }

    const ctx = { win, pi, pre, post, contact, w, s, fwd, lvl: LEVEL_SCALE[this.opts.level] ?? 1 };
    const metrics = (ANALYZERS[stroke] || ANALYZERS.forehand).call(this, ctx);
    const valid = metrics.filter((m) => m.score != null);
    if (!valid.length) return null;
    const lefty = this.opts.hand === 'L';
    for (const m of valid) {
      m.tip = m.tip.replaceAll('{N}', lefty ? '오른쪽' : '왼쪽')
        .replaceAll('{D}', lefty ? '왼쪽' : '오른쪽')
        .replaceAll('{NH}', lefty ? '오른손' : '왼손');
    }

    const totalW = valid.reduce((acc, m) => acc + (m.weight || 1), 0);
    const overall = Math.round(valid.reduce((acc, m) => acc + m.score * (m.weight || 1), 0) / totalW);
    for (const m of valid) m.status = statusOf(m.score);

    const tip = this.pickTip(valid, stroke);
    return {
      stroke, label: STROKES[stroke], overall, metrics: valid, tip, note,
      speed: Math.round(this.peak.v * 10) / 10, t: peakT,
    };
  }

  classify(win, pi, s) {
    const c = win[pi];
    const nose = c.w[L.nose];
    // Overhead: dominant wrist clearly above head around contact.
    const near = win.slice(Math.max(0, pi - 3), pi + 3);
    const topWr = Math.min(...near.map((f) => f.w[s.D.wr].y));
    if (topWr < nose.y - 0.12) return 'serve';
    // Forehand vs backhand: where was the wrist during the backswing?
    const pre = win.slice(Math.max(0, pi - 30), pi);
    let minLat = Infinity, maxLat = -Infinity;
    for (const f of pre) {
      const v = lateral(f, s, f.w[s.D.wr]);
      minLat = Math.min(minLat, v);
      maxLat = Math.max(maxLat, v);
    }
    // Forehand backswing sits on the dominant side (negative lateral).
    return Math.abs(minLat) >= Math.abs(maxLat) ? 'forehand' : 'backhand';
  }

  pickTip(metrics, stroke) {
    // Lowest score wins; fundamentals (low prio number) break near-ties.
    const rank = (m) => m.score + 3 * (m.prio ?? 5);
    const ordered = [...metrics].sort((a, b) => rank(a) - rank(b));
    const worst = ordered[0];
    let tip;
    if (worst.score >= 85) {
      const best = [...metrics].sort((a, b) => b.score - a.score)[0];
      tip = { kind: 'praise', key: 'praise', text: PRAISE[(this.lastTips.length) % PRAISE.length].replace('{m}', best.label) };
    } else {
      tip = { kind: worst.score < 65 ? 'fix' : 'refine', key: worst.key, text: worst.tip };
      const repeats = this.lastTips.slice(-2).filter((k) => k === worst.key).length;
      if (repeats === 2) tip.text = `${worst.label}, 계속 의식해 보세요. ${worst.tip}`;
    }
    this.lastTips.push(tip.key);
    if (this.lastTips.length > 10) this.lastTips.shift();
    return tip;
  }
}

const PRAISE = [
  '좋아요! {m} 아주 잘 됐어요.',
  '나이스 샷! 지금 느낌 그대로 유지하세요.',
  '훌륭해요. {m} 완벽합니다.',
  '좋습니다. 이 리듬 그대로 반복하세요.',
];

// ---------- metric builders ----------
function metric(key, label, value, ok, good, tip, extra = {}) {
  if (value == null || Number.isNaN(value)) return { key, label, score: null };
  return { key, label, value, score: Math.round(scoreOf(value, ok, good)), tip, ...extra };
}

function bodyTurn(ctx, good, ok) {
  const { pre, post, s, lvl } = ctx;
  const fin = post[post.length - 1];
  const finYaw = shoulderYaw(fin, s);
  let turn = 0, tbIdx = 0;
  pre.forEach((f, i) => {
    const d = Math.abs(angDiff(shoulderYaw(f, s), finYaw));
    if (d > turn) { turn = d; tbIdx = i; }
  });
  return { turn, tbIdx, good: good * lvl, ok: ok * lvl };
}

function separation(ctx) {
  let best = 0;
  for (const f of ctx.pre) best = Math.max(best, Math.abs(angDiff(shoulderYaw(f, ctx.s), hipYaw(f, ctx.s))));
  return best;
}

function takebackDepth(ctx, tbIdx) {
  const { pre, s, fwd } = ctx;
  // Deepest point of the backswing behind the shoulders, against the swing direction.
  let depth = -Infinity;
  for (const f of pre.slice(0, Math.max(1, tbIdx + 4))) {
    const shc = mid(f.w[s.D.sh], f.w[s.N.sh]);
    depth = Math.max(depth, -dotXZ(sub(f.w[s.D.wr], shc), fwd));
  }
  return depth;
}

function contactInFront(ctx) {
  const { w, s, fwd } = ctx;
  const shc = mid(w[s.D.sh], w[s.N.sh]);
  return dotXZ(sub(w[s.D.wr], shc), fwd);
}

function headStill(ctx) {
  const { win, pi } = ctx;
  const c = win[pi];
  if ((c.n[L.nose].visibility ?? 1) < 0.5) return null;
  const tor = imgTorso(c);
  let maxD = 0;
  for (const f of win.slice(pi, pi + 8)) {
    maxD = Math.max(maxD, Math.hypot(f.n[L.nose].x - c.n[L.nose].x, f.n[L.nose].y - c.n[L.nose].y) / tor);
  }
  return maxD;
}

function kneeMetric(ctx, frames, good, ok, tip) {
  const k = minKneeAngle(frames);
  return metric('knees', '하체 (무릎)', k, ok, good, tip, { unit: '°', joints: [L.lKnee, L.rKnee], prio: 4 });
}

// Wrist position after contact: furthest across the body and highest point.
function finishOf(ctx) {
  const { post, s } = ctx;
  let across = -Infinity, sameSide = Infinity, high = -Infinity;
  for (const f of post) {
    const lat = lateral(f, s, f.w[s.D.wr]);
    across = Math.max(across, lat);
    sameSide = Math.min(sameSide, lat);
    high = Math.max(high, f.w[s.D.sh].y - f.w[s.D.wr].y);
  }
  return { across, sameSide, high };
}

// ---------- stroke analyzers ----------
export const ANALYZERS = {
  forehand(ctx) {
    const { w, s } = ctx;
    const bt = bodyTurn(ctx, 70, 45);
    const depth = takebackDepth(ctx, bt.tbIdx);
    const elbow = jointAngle(w[s.D.sh], w[s.D.el], w[s.D.wr]);
    const front = contactInFront(ctx);
    const fin = finishOf(ctx);
    const contactScore = Math.min(scoreOf(elbow, 90, 110), scoreOf(front, -0.05, 0.12));
    const contactTip = elbow < 100
      ? '타점이 몸에 너무 붙어요. 팔과 몸 사이에 공간을 두고 치세요.'
      : '타점이 늦어요. 공을 몸 앞쪽에서 맞히세요.';
    const finScore = Math.min(scoreOf(fin.across, 0, 0.15), scoreOf(fin.high, -0.25, -0.05));
    const finTip = fin.across < 0.05
      ? '팔로스루를 끝까지! 라켓을 반대쪽 어깨 너머로 감아주세요.'
      : '스윙을 낮은 곳에서 높은 곳으로, 어깨 높이까지 끌어올리세요.';
    return [
      metric('turn', '바디턴', bt.turn, bt.ok, bt.good,
        '어깨를 더 돌려주세요. 유닛턴 때 {N} 어깨가 공을 향하게.', { unit: '°', joints: [L.lSh, L.rSh], prio: 1, weight: 1.3 }),
      metric('takeback', '테이크백', depth, 0.18, 0.32,
        '테이크백을 더 크게, 일찍 준비하세요. 라켓을 몸 뒤까지 빼주세요.', { unit: 'm', joints: [s.D.wr, s.D.el], prio: 2 }),
      { key: 'contact', label: '타점', value: front, unit: 'm', score: Math.round(contactScore), tip: contactTip, joints: [s.D.el, s.D.wr], prio: 2, weight: 1.2 },
      { key: 'finish', label: '팔로스루', value: fin.across, unit: 'm', score: Math.round(finScore), tip: finTip, joints: [s.D.wr, s.N.sh], prio: 3 },
      kneeMetric(ctx, ctx.pre, 150, 165, '무릎을 더 굽혀 낮은 자세에서 위로 밀어 올리세요.'),
      metric('head', '머리 고정', headStill(ctx), 0.35, 0.18,
        '임팩트 순간 머리를 타점에 잠깐 고정하세요.', { joints: [L.nose], prio: 6, weight: 0.7 }),
    ];
  },

  backhand(ctx) {
    const { w, s } = ctx;
    const two = this.opts.backhand !== 'one';
    const bt = bodyTurn(ctx, 75, 50);
    const depth = takebackDepth(ctx, bt.tbIdx);
    const front = contactInFront(ctx);
    const fin = finishOf(ctx);
    const out = [
      metric('turn', '바디턴', bt.turn, bt.ok, bt.good,
        '어깨를 더 돌리세요. 등이 네트를 살짝 보일 정도로 턴하세요.', { unit: '°', joints: [L.lSh, L.rSh], prio: 1, weight: 1.3 }),
      metric('takeback', '테이크백', depth, 0.15, 0.28,
        '라켓을 더 일찍, 뒤로 충분히 빼주세요.', { unit: 'm', joints: [s.D.wr, s.N.wr], prio: 2 }),
      metric('contact', '타점', front, -0.02, 0.15,
        '타점이 늦어요. 앞발보다 앞에서 공을 맞히세요.', { unit: 'm', joints: [s.D.wr], prio: 2, weight: 1.2 }),
    ];
    // Backhand follows through to the dominant side, high.
    const finScore = Math.min(scoreOf(-fin.sameSide, 0, 0.12), scoreOf(fin.high, -0.25, -0.05));
    out.push({
      key: 'finish', label: '팔로스루', value: -fin.sameSide, unit: 'm', score: Math.round(finScore),
      tip: two ? '팔로스루를 높게! 손이 {D} 어깨 위에서 끝나도록 끝까지 휘두르세요.'
        : '팔로스루를 높게 뻗으세요. 끝까지 라켓이 하늘을 향하게.',
      joints: [s.D.wr, s.D.sh], prio: 3,
    });
    if (two) {
      const gap = len(sub(w[s.D.wr], w[s.N.wr]));
      out.push(metric('grip', '양손 유지', gap, 0.22, 0.14,
        '양손을 붙인 채로 임팩트하세요. {NH}이 주도하는 느낌으로.', { unit: 'm', joints: [L.lWr, L.rWr], prio: 3, weight: 0.8 }));
    } else {
      const elbow = jointAngle(w[s.D.sh], w[s.D.el], w[s.D.wr]);
      out.push(metric('arm', '팔 뻗기', elbow, 140, 158,
        '한손 백핸드는 팔을 곧게 펴고 몸 앞에서 맞히세요.', { unit: '°', joints: [s.D.el], prio: 2 }));
      let spread = 0;
      for (const f of ctx.post) spread = Math.max(spread, len(sub(f.w[s.D.wr], f.w[s.N.wr])));
      out.push(metric('balance', '반대팔 균형', spread, 0.45, 0.7,
        '임팩트 후 반대 손은 뒤로 뻗어 몸이 열리지 않게 잡아주세요.', { unit: 'm', joints: [s.N.wr], prio: 5, weight: 0.7 }));
    }
    out.push(kneeMetric(ctx, ctx.pre, 150, 165, '무릎을 굽혀 낮게 준비하고, 다리로 밀어 올리세요.'));
    out.push(metric('head', '머리 고정', headStill(ctx), 0.35, 0.18,
      '임팩트 순간 머리를 고정하고 타점을 끝까지 보세요.', { joints: [L.nose], prio: 6, weight: 0.7 }));
    return out;
  },

  serve(ctx) {
    const { win, pi, pre, post, s } = ctx;
    // Trophy position: toss arm at its highest before the swing.
    let ti = 0;
    pre.forEach((f, i) => { if (f.t < ctx.contact.t - 0.1 && f.w[s.N.wr].y < pre[ti].w[s.N.wr].y) ti = i; });
    const tr = pre[ti].w;
    const tossHigh = tr[L.nose].y - tr[s.N.wr].y; // >0: toss hand above head
    const elbowUp = tr[s.D.sh].y - tr[s.D.el].y; // >0: elbow above shoulder
    const trophy = Math.min(scoreOf(tossHigh, 0, 0.15), scoreOf(elbowUp, -0.18, -0.05));
    const trophyTip = tossHigh < 0.05
      ? '토스한 팔을 머리 위로 끝까지 뻗어 트로피 자세를 만드세요.'
      : '트로피 자세에서 라켓 팔꿈치를 어깨 높이까지 들어 올리세요.';
    // Shoulder tilt at trophy (cartwheel): non-dominant shoulder higher.
    const dx = Math.hypot(tr[s.D.sh].x - tr[s.N.sh].x, tr[s.D.sh].z - tr[s.N.sh].z) || 1e-3;
    const tilt = deg(Math.atan2(tr[s.D.sh].y - tr[s.N.sh].y, dx));
    // Reach at contact: highest wrist point around contact.
    let hi = pi;
    for (let i = Math.max(0, pi - 4); i < Math.min(win.length, pi + 4); i++) if (win[i].w[s.D.wr].y < win[hi].w[s.D.wr].y) hi = i;
    const hw = win[hi].w;
    const reach = Math.min(
      scoreOf(jointAngle(hw[s.D.sh], hw[s.D.el], hw[s.D.wr]), 140, 158),
      scoreOf(hw[L.nose].y - hw[s.D.wr].y, 0.2, 0.35),
    );
    let down = -Infinity, across = -Infinity;
    for (const f of post) {
      down = Math.max(down, f.w[s.D.wr].y - mid(f.w[s.D.hip], f.w[s.N.hip]).y);
      across = Math.max(across, lateral(f, s, f.w[s.D.wr]));
    }
    const finish = Math.min(scoreOf(down, -0.35, -0.1), scoreOf(across, -0.1, 0.05));
    const kneeFrames = pre.filter((f) => f.t >= pre[ti].t - 0.6);
    return [
      { key: 'trophy', label: '트로피 자세', value: tossHigh, unit: 'm', score: Math.round(trophy), tip: trophyTip, joints: [s.N.wr, s.D.el], prio: 1, weight: 1.3 },
      metric('tilt', '어깨 기울기', tilt, 6, 15,
        '트로피에서 토스 팔 쪽 어깨를 높이고, 라켓 쪽 어깨는 낮추세요.', { unit: '°', joints: [L.lSh, L.rSh], prio: 3 }),
      kneeMetric(ctx, kneeFrames.length ? kneeFrames : pre, 150, 165,
        '트로피에서 무릎을 굽혔다가 위로 차고 올라가세요.'),
      { key: 'reach', label: '타점 높이', score: Math.round(reach), tip: '가장 높은 곳에서 팔을 쭉 뻗어 맞히세요.', joints: [s.D.el, s.D.wr], prio: 2, weight: 1.2 },
      { key: 'finish', label: '팔로스루', value: across, unit: 'm', score: Math.round(finish), tip: '임팩트 후 라켓을 반대쪽 허리 아래까지 끌어내리세요.', joints: [s.D.wr], prio: 4 },
    ];
  },

  smash(ctx) {
    const { win, pi, pre, post, s } = ctx;
    const bt = bodyTurn(ctx, 60, 40);
    let point = -Infinity;
    for (const f of pre) point = Math.max(point, f.w[s.N.sh].y - f.w[s.N.wr].y);
    let hi = pi;
    for (let i = Math.max(0, pi - 4); i < Math.min(win.length, pi + 4); i++) if (win[i].w[s.D.wr].y < win[hi].w[s.D.wr].y) hi = i;
    const hw = win[hi].w;
    const reach = Math.min(
      scoreOf(jointAngle(hw[s.D.sh], hw[s.D.el], hw[s.D.wr]), 135, 155),
      scoreOf(hw[L.nose].y - hw[s.D.wr].y, 0.15, 0.3),
    );
    let across = -Infinity;
    for (const f of post) across = Math.max(across, lateral(f, s, f.w[s.D.wr]));
    return [
      metric('turn', '옆으로 서기', bt.turn, bt.ok, bt.good,
        '공이 뜨면 바로 몸을 옆으로 돌려 사이드 스텝으로 들어가세요.', { unit: '°', joints: [L.lSh, L.rSh], prio: 1, weight: 1.2 }),
      metric('point', '반대손 조준', point, 0.1, 0.25,
        '반대 손으로 공을 가리키며 거리를 맞추세요.', { unit: 'm', joints: [s.N.wr], prio: 2 }),
      { key: 'reach', label: '타점 높이', score: Math.round(reach), tip: '몸 앞, 가장 높은 곳에서 팔을 펴고 때리세요.', joints: [s.D.el, s.D.wr], prio: 2, weight: 1.2 },
      metric('finish', '팔로스루', across, -0.1, 0.05,
        '끝까지 휘둘러 라켓이 반대쪽 옆구리로 내려오게 하세요.', { unit: 'm', joints: [s.D.wr], prio: 3 }),
    ];
  },

  volley(ctx) {
    const { win, pi, pre, post, s, fwd, contact } = ctx;
    const cw = contact.w[s.D.wr];
    let back = 0, through = 0;
    for (const f of pre.filter((f) => f.t >= contact.t - 0.6)) back = Math.max(back, -dotXZ(sub(f.w[s.D.wr], cw), fwd));
    for (const f of post) through = Math.max(through, dotXZ(sub(f.w[s.D.wr], cw), fwd));
    // Split step: vertical bounce of the hips in the image before contact.
    const sp = win.filter((f) => f.t >= contact.t - 1.3 && f.t <= contact.t - 0.15);
    let split = null;
    if (sp.length > 5) {
      const ys = sp.map((f) => (f.n[L.lHip].y + f.n[L.rHip].y) / 2);
      split = (Math.max(...ys) - Math.min(...ys)) / imgTorso(contact);
    }
    return [
      metric('takeback', '짧은 백스윙', back, 0.42, 0.28,
        '백스윙이 커요. 라켓을 몸 앞에 두고 짧게 블록하세요.', { unit: 'm', joints: [s.D.wr], prio: 1, weight: 1.3 }),
      metric('contact', '타점', contactInFront(ctx), 0.05, 0.2,
        '공을 몸 앞에서 잡으세요. 한 걸음 앞으로 나가며 맞히세요.', { unit: 'm', joints: [s.D.wr], prio: 2, weight: 1.2 }),
      metric('finish', '짧은 팔로스루', through, 0.5, 0.35,
        '팔로스루는 짧게, 펀치하듯 끊어주세요.', { unit: 'm', joints: [s.D.wr], prio: 3 }),
      kneeMetric(ctx, win, 155, 168, '무릎을 굽혀 낮은 공은 다리로 내려가서 받으세요.'),
      metric('split', '스플릿 스텝', split, 0.03, 0.07,
        '상대가 칠 때 스플릿 스텝으로 가볍게 뛰어 준비하세요.', { joints: [L.lAnk, L.rAnk], prio: 7, weight: 0.6 }),
    ];
  },
};
