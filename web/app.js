import { PoseLandmarker } from './vendor/vision_bundle.mjs';
import { SwingCoach, STROKES, L } from './analysis.js';

const $ = (id) => document.getElementById(id);

// ---------- settings ----------
const SETTINGS_KEY = 'courtside-coach-settings';
const defaults = {
  stroke: 'forehand', hand: 'R', backhand: 'two', level: 'intermediate',
  sensitivity: 1, voice: true, sayScore: false, cam: 'environment', model: 'full', delegate: 'GPU',
};
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

const coach = new SwingCoach(coachOpts());
function coachOpts() {
  const { stroke, hand, backhand, level, sensitivity } = settings;
  return { stroke, hand, backhand, level, sensitivity };
}

// ---------- voice ----------
const native = window.TennisNative;
let koVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  koVoice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('ko')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function speak(text) {
  if (!settings.voice || !text) return;
  if (native?.speak) { native.speak(text); return; }
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  if (koVoice) u.voice = koVoice;
  u.rate = 1.08;
  speechSynthesis.speak(u);
}

// ---------- stroke chips ----------
const STROKE_ORDER = ['forehand', 'backhand', 'serve', 'volley', 'smash', 'auto'];
function renderChips(container, compact) {
  container.innerHTML = '';
  for (const key of STROKE_ORDER) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.stroke === key));
    b.textContent = compact && key === 'auto' ? '자동' : STROKES[key];
    b.addEventListener('click', () => setStroke(key));
    container.appendChild(b);
  }
}
function setStroke(key) {
  settings.stroke = key;
  saveSettings();
  coach.set(coachOpts());
  renderChips($('strokeChips'), false);
  renderChips($('strokeChips2'), true);
  updateMeterThreshold();
  if (running) {
    resetCard(`${STROKES[key]} 연습`, `${STROKES[key]} 스윙을 해보세요.`);
    renderHistory();
  }
}
renderChips($('strokeChips'), false);
renderChips($('strokeChips2'), true);

// ---------- pose model ----------
let landmarker = null;
let landmarkerModel = null;
async function loadLandmarker() {
  const want = `${settings.model}/${settings.delegate}`;
  if (landmarker && landmarkerModel === want) return;
  setStatus('AI 모델 불러오는 중…');
  landmarker?.close();
  landmarker = null;
  const fileset = {
    wasmLoaderPath: new URL('wasm/vision_wasm_internal.js', location.href).href,
    wasmBinaryPath: new URL('wasm/vision_wasm_internal.wasm', location.href).href,
  };
  const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `models/pose_landmarker_${settings.model}.task`, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await make(settings.delegate);
    delegateName = settings.delegate;
  } catch (e) {
    if (settings.delegate === 'CPU') throw e;
    console.warn('GPU delegate failed, using CPU', e);
    landmarker = await make('CPU');
    delegateName = 'CPU';
  }
  landmarkerModel = want;
}
let delegateName = '';

// ---------- camera ----------
const video = $('video');
const canvas = $('overlay');
const ctx2d = canvas.getContext('2d');
let stream = null;

async function startCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: settings.cam,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, max: 60 },
    },
  });
  video.srcObject = stream;
  await video.play();
  $('stage').classList.toggle('mirror', settings.cam === 'user');
}
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

// ---------- main loop ----------
let running = false;
let lastVideoTime = -1;
let fpsFrames = 0, fpsSince = performance.now();
let lastSeen = 0, badFramingSince = 0, framingWarned = false;
let highlight = null; // { joints:Set, until }
let wakeLock = null;

async function start() {
  const btn = $('startBtn');
  btn.disabled = true;
  btn.textContent = '카메라 여는 중…';
  try {
    $('setup').hidden = true;
    $('coach').hidden = false;
    setStatus('카메라 여는 중…');
    await startCamera();
    await loadLandmarker();
    running = true;
    coach.set(coachOpts());
    updateMeterThreshold();
    setStatus(`분석 중 · ${delegateName}`, 'live');
    resetCard(`${STROKES[settings.stroke]} 연습`, '준비되면 스윙하세요. 한 번 칠 때마다 바로 알려드려요.');
    speak(`${STROKES[settings.stroke]} 코칭을 시작합니다. 전신이 화면에 보이게 서 주세요.`);
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    stopCamera();
    $('coach').hidden = true;
    $('setup').hidden = false;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    alertSetup(denied
      ? '카메라 권한이 필요해요. 설정 > 애플리케이션에서 카메라를 허용한 뒤 다시 시도하세요.'
      : `시작하지 못했어요: ${e?.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '코칭 시작';
  }
}

function alertSetup(msg) {
  let p = document.querySelector('.setup .error');
  if (!p) {
    p = document.createElement('p');
    p.className = 'error fine';
    p.style.color = 'var(--bad)';
    $('startBtn').after(p);
  }
  p.textContent = msg;
}

function stop() {
  running = false;
  stopCamera();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  native?.stop?.();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $('coach').hidden = true;
  $('setup').hidden = false;
}

function loop() {
  if (!running) return;
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    let res = null;
    try { res = landmarker.detectForVideo(video, now); } catch (e) { console.warn(e); }
    if (res) onPose(res, now);
    fpsFrames++;
  }
  if (now - fpsSince > 1000) {
    $('fps').textContent = `${Math.round((fpsFrames * 1000) / (now - fpsSince))} fps`;
    fpsFrames = 0;
    fpsSince = now;
  }
  requestAnimationFrame(loop);
}

function onPose(res, now) {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  const n = res.landmarks?.[0];
  const w = res.worldLandmarks?.[0];
  if (!n || !w) {
    checkFraming(false, now);
    meter(0);
    return;
  }
  lastSeen = now;
  // World landmarks carry no visibility; borrow it from the image landmarks.
  const wv = w.map((p, i) => ({ x: p.x, y: p.y, z: p.z, visibility: n[i].visibility ?? 1 }));
  const fullBody = [L.nose, L.lAnk, L.rAnk].every((i) => (n[i].visibility ?? 1) > 0.45);
  checkFraming(fullBody, now);

  const result = coach.push({ t: now / 1000, w: wv, n });
  meter(coach.speed);
  trackMiss(now / 1000);
  drawSkeleton(n, now);
  if (result) onSwing(result, now);
}

function checkFraming(ok, now) {
  const banner = $('banner');
  if (ok) {
    badFramingSince = 0;
    banner.hidden = true;
    return;
  }
  if (!badFramingSince) badFramingSince = now;
  if (now - badFramingSince > 1500) {
    banner.textContent = now - lastSeen > 1500
      ? '사람이 보이지 않아요. 화면 안으로 들어와 주세요.'
      : '머리부터 발끝까지 화면에 들어오게 카메라를 조금 멀리 두세요.';
    banner.hidden = false;
    if (!framingWarned) {
      speak('전신이 화면에 보이도록 조정해 주세요.');
      framingWarned = true;
    }
  }
}

// ---------- drawing ----------
const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32],
];
function drawSkeleton(n, now) {
  const W = canvas.width, H = canvas.height;
  const scale = Math.max(W, H) / 900;
  const domWr = settings.hand === 'L' ? L.lWr : L.rWr;
  const domEl = settings.hand === 'L' ? L.lEl : L.rEl;
  const domSh = settings.hand === 'L' ? L.lSh : L.rSh;
  const isDomArm = (a, b) => [domSh, domEl, domWr].includes(a) && [domSh, domEl, domWr].includes(b);
  const hl = highlight && now < highlight.until ? highlight.joints : null;

  ctx2d.lineCap = 'round';
  for (const [a, b] of BONES) {
    const pa = n[a], pb = n[b];
    if ((pa.visibility ?? 1) < 0.3 || (pb.visibility ?? 1) < 0.3) continue;
    ctx2d.strokeStyle = isDomArm(a, b) ? '#d9f24b' : 'rgba(242,245,248,0.85)';
    ctx2d.lineWidth = (isDomArm(a, b) ? 6 : 4) * scale;
    ctx2d.beginPath();
    ctx2d.moveTo(pa.x * W, pa.y * H);
    ctx2d.lineTo(pb.x * W, pb.y * H);
    ctx2d.stroke();
  }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    const p = n[i];
    if ((p.visibility ?? 1) < 0.3) continue;
    const hot = hl?.has(i);
    ctx2d.fillStyle = hot ? '#ff6b4a' : i === domWr ? '#d9f24b' : '#0b1726';
    ctx2d.strokeStyle = hot ? '#ff6b4a' : '#f2f5f8';
    ctx2d.lineWidth = 2.5 * scale;
    ctx2d.beginPath();
    ctx2d.arc(p.x * W, p.y * H, (hot ? 13 : i === domWr ? 8 : 5) * scale, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.stroke();
    if (hot) {
      ctx2d.strokeStyle = 'rgba(255,107,74,0.45)';
      ctx2d.lineWidth = 6 * scale;
      ctx2d.beginPath();
      ctx2d.arc(p.x * W, p.y * H, 24 * scale, 0, Math.PI * 2);
      ctx2d.stroke();
    }
  }
}

// ---------- speed meter ----------
const meterFill = $('meterFill');
function meterMax() { return coach.threshold * 2; }
function meter(v) {
  const pct = Math.min(100, (v / meterMax()) * 100);
  meterFill.style.height = `${pct}%`;
  meterFill.classList.toggle('hot', v > coach.threshold);
}
function updateMeterThreshold() { $('meterThr').style.bottom = '50%'; }

// ---------- feedback card ----------
const history = [];
function setStatus(text, cls = '') {
  const p = $('statusPill');
  p.textContent = text;
  p.className = `pill ${cls}`;
}

function resetCard(title, tip) {
  $('card').className = 'card empty';
  $('cardStroke').textContent = title;
  $('cardTip').textContent = tip;
  $('cardTip').className = 'card-tip';
  const ring = $('cardScore');
  ring.style.setProperty('--p', 0);
  ring.className = 'score-ring';
  ring.querySelector('span').textContent = '–';
  $('metricList').innerHTML = '';
}

const fmtVal = (m) => {
  if (m.value == null || !m.unit) return '';
  if (m.unit === '°') return `${Math.round(m.value)}°`;
  if (m.unit === 'm') return `${Math.round(m.value * 100)}cm`;
  return '';
};

function metricEl(m, showVal = true) {
  const d = document.createElement('div');
  d.className = `metric ${m.status}`;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = m.label;
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = showVal ? `${m.score}${fmtVal(m) ? ' · ' + fmtVal(m) : ''}` : String(m.score);
  const bar = document.createElement('span');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = `${m.score}%`;
  bar.appendChild(fill);
  d.append(name, val, bar);
  return d;
}

function onSwing(r, now) {
  recordSwing(r);
  if (r.skipped) {
    $('lastNote').textContent = r.note;
    return;
  }
  history.push({ ...r, at: Date.now() });
  const card = $('card');
  card.className = 'card';
  void card.offsetWidth;
  card.classList.add('flash');
  $('cardStroke').textContent = `${r.label} · 손목 ${r.speed} m/s`;
  $('cardTip').textContent = r.tip.text;
  $('cardTip').className = `card-tip ${r.tip.kind}`;
  const ring = $('cardScore');
  ring.style.setProperty('--p', r.overall);
  ring.className = `score-ring ${r.overall >= 85 ? 'good' : r.overall >= 65 ? 'ok' : 'bad'}`;
  ring.querySelector('span').textContent = r.overall;
  const list = $('metricList');
  list.innerHTML = '';
  for (const m of r.metrics) list.appendChild(metricEl(m));
  $('lastNote').textContent = r.note || '';
  updateSession();

  const worst = r.metrics.filter((m) => m.status === 'bad').flatMap((m) => m.joints || []);
  highlight = worst.length ? { joints: new Set(worst), until: now + 2500 } : null;

  const prefix = settings.sayScore ? `${r.overall}점. ` : '';
  speak(prefix + r.tip.text);
}

function updateSession() {
  const done = history.filter((h) => !h.skipped);
  $('swingCount').textContent = done.length;
  $('avgScore').textContent = done.length ? Math.round(done.reduce((a, h) => a + h.overall, 0) / done.length) : '–';
}

function renderHistory() {
  const sum = $('historySummary');
  const list = $('historyList');
  sum.innerHTML = '';
  list.innerHTML = '';
  if (!history.length) {
    list.innerHTML = '<li class="empty-note" style="display:block">아직 기록된 스윙이 없어요.</li>';
    return;
  }
  // Average per metric across swings of the same stroke as the latest swing.
  const stroke = history[history.length - 1].stroke;
  const same = history.filter((h) => h.stroke === stroke);
  const acc = new Map();
  for (const h of same) for (const m of h.metrics) {
    const a = acc.get(m.key) || { label: m.label, total: 0, n: 0 };
    a.total += m.score; a.n++;
    acc.set(m.key, a);
  }
  const head = document.createElement('div');
  head.className = 'card-stroke';
  head.style.gridColumn = '1 / -1';
  head.textContent = `${STROKES[stroke]} 평균 (${same.length}회)`;
  sum.appendChild(head);
  for (const [key, a] of acc) {
    const score = Math.round(a.total / a.n);
    sum.appendChild(metricEl({ key, label: a.label, score, status: score >= 85 ? 'good' : score >= 65 ? 'ok' : 'bad' }, false));
  }
  for (const h of [...history].reverse()) {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.className = `hs ${h.overall >= 85 ? 'good' : h.overall >= 65 ? 'ok' : 'bad'}`;
    s.textContent = h.overall;
    const t = document.createElement('div');
    const time = new Date(h.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    t.innerHTML = '<div></div><div class="ht"></div>';
    t.firstChild.textContent = h.tip.text;
    t.lastChild.textContent = `${h.label} · ${time}`;
    li.append(s, t);
    list.appendChild(li);
  }
}

// ---------- settings UI ----------
function bindSettings() {
  const sel = (id, key, after) => {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('change', () => { settings[key] = el.value; saveSettings(); after?.(); });
  };
  const chk = (id, key) => {
    const el = $(id);
    el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); });
  };
  const reconfigure = () => coach.set(coachOpts());
  sel('optHand', 'hand', reconfigure);
  sel('optBackhand', 'backhand', reconfigure);
  sel('optLevel', 'level', reconfigure);
  sel('optCam', 'cam', async () => { if (running) await startCamera().catch((e) => setStatus(`카메라 오류: ${e.message}`, 'warn')); });
  const reloadModel = async () => {
    if (!running) return;
    try { await loadLandmarker(); setStatus(`분석 중 · ${delegateName}`, 'live'); } catch (e) { setStatus(`모델 오류: ${e.message}`, 'warn'); }
  };
  sel('optModel', 'model', reloadModel);
  sel('optDelegate', 'delegate', reloadModel);
  chk('optVoice', 'voice');
  chk('optSayScore', 'sayScore');
  const sens = $('optSens');
  sens.value = settings.sensitivity;
  $('sensVal').textContent = `${Number(settings.sensitivity).toFixed(2)}×`;
  sens.addEventListener('input', () => {
    settings.sensitivity = Number(sens.value);
    $('sensVal').textContent = `${settings.sensitivity.toFixed(2)}×`;
    coach.opts.sensitivity = settings.sensitivity;
    saveSettings();
  });
}
bindSettings();

$('startBtn').addEventListener('click', start);
$('backBtn').addEventListener('click', stop);
$('settingsBtn').addEventListener('click', () => { $('settings').hidden = false; });
$('closeSettings').addEventListener('click', () => { $('settings').hidden = true; });
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });
$('historyBtn').addEventListener('click', () => { renderHistory(); $('history').hidden = false; });
$('closeHistory').addEventListener('click', () => { $('history').hidden = true; });
$('history').addEventListener('click', (e) => { if (e.target === $('history')) $('history').hidden = true; });
$('resetSession').addEventListener('click', () => {
  history.length = 0;
  recorded.length = 0;
  misses.length = 0;
  updateSession();
  renderHistory();
});
$('exportBtn').addEventListener('click', exportSwings);
$('testVoice').addEventListener('click', () => {
  const was = settings.voice;
  settings.voice = true;
  speak('어깨를 더 돌려주세요. 유닛턴 때 왼쪽 어깨가 공을 향하게.');
  settings.voice = was;
});

// Android back button (called from the native shell). Returns true if handled.
window.courtsideBack = () => {
  if (!$('settings').hidden) { $('settings').hidden = true; return true; }
  if (!$('history').hidden) { $('history').hidden = true; return true; }
  if (running) { stop(); return true; }
  return false;
};
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }
});

// Test hook: lets automated checks run the pipeline on a still image.
window.__courtside = { loadLandmarker, getLandmarker: () => landmarker, coach, settings };

// ---------- swing data export (for tuning the coach on real swings) ----------
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const recorded = [];
const misses = [];
let missPeak = null;
const r3 = (x) => Math.round(x * 1000) / 1000;

function recordSwing(r) {
  const frames = coach.buf
    .filter((f) => f.t >= r.t - 2.3 && f.t <= r.t + 0.6)
    .map((f) => ({
      t: r3(f.t - r.t),
      v: r3(f.v ?? 0),
      w: JOINTS.map((i) => [r3(f.w[i].x), r3(f.w[i].y), r3(f.w[i].z), Math.round((f.w[i].visibility ?? 1) * 100) / 100]),
      n: JOINTS.map((i) => [r3(f.n[i].x), r3(f.n[i].y)]),
    }));
  const summary = r.skipped
    ? { skipped: true, stroke: r.stroke, note: r.note }
    : {
        stroke: r.stroke, overall: r.overall, speed: r.speed, tip: r.tip.text,
        metrics: r.metrics.map((m) => ({ key: m.key, score: m.score, value: m.value == null ? null : r3(m.value) })),
      };
  recorded.push({ at: new Date().toISOString(), selected: settings.stroke, ...summary, frames });
  if (recorded.length > 60) recorded.shift();
}

// Speed peaks that came close to the threshold but did not count as a swing.
function trackMiss(t) {
  const thr = coach.threshold;
  const v = coach.speed;
  if (coach.state === 'idle' && v > thr * 0.45 && v <= thr) {
    if (!missPeak || v > missPeak.v) missPeak = { t, v };
  } else if (missPeak && (v < thr * 0.3 || coach.state !== 'idle')) {
    if (coach.state === 'idle') misses.push({ at: new Date().toISOString(), v: r3(missPeak.v), thr: r3(thr) });
    if (misses.length > 200) misses.shift();
    missPeak = null;
  }
}

function exportSwings() {
  const note = $('exportNote');
  if (!recorded.length && !misses.length) {
    note.textContent = '아직 기록된 스윙이 없어요. 몇 번 스윙한 뒤 다시 눌러 주세요.';
    return;
  }
  const data = {
    app: 'courtside-coach', version: '0.1.1', exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    video: { w: video.videoWidth, h: video.videoHeight },
    model: settings.model, delegate: delegateName,
    settings: coachOpts(), threshold: r3(coach.threshold),
    joints: JOINTS, swings: recorded, misses,
  };
  const json = JSON.stringify(data);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `courtside-swings-${stamp}.json`;
  if (native?.saveAndShare) {
    const where = native.saveAndShare(name, json);
    note.textContent = where
      ? `${where}에 저장했어요. 공유 창에서 Claude를 고르거나, 이 파일을 대화에 첨부해 주세요.`
      : '저장하지 못했어요. 저장 공간을 확인해 주세요.';
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  note.textContent = `${name} 파일을 내려받았어요.`;
}
