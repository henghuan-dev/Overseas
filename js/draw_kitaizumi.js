// draw_kitaizumi.js — 無料は「今日0:00〜明日23:00」の48hだけ波高表示
// - window.PAY_MODE: 'free' | 'paid'
// - 他レイヤ（潮・風・時間軸）はフル表示
// - マスク（.wave-mask）は HTML 側の要素を draw.js 側で「終端ピクセル」から右を覆うように配置
// - マスク上では波TT(#tooltip)を背面化

/* ================== 状態 ================== */
let rowsAll = [];
let hoursTs = [];
let hours   = [];

let waveHeights = [];
let tideLevels  = [];
let windSpeeds  = [];
let windAngles  = [];
let windDirectionTypes = [];
let swellsByHour = [];

// 無料48hの描画窓（JST）
let wave48_indexStart = 0; // 今日 0:00
let wave48_indexEnd   = 0; // 明後日 0:00（＝明日 23:00 の次の列）

let timelinePointName = "";
let colWidth = 50;
let dayDividers = [];

/* =============== ユーティリティ =============== */
const dpr = () => window.devicePixelRatio || 1;
const toJST = (d) => new Date(d.getTime() + 9 * 3600 * 1000);
function jstYMDHM(d) {
  const j = toJST(d);
  return { m: j.getUTCMonth() + 1, day: j.getUTCDate(), h: j.getUTCHours() };
}
function setupHiDPICanvas(canvas, cssW, cssH) {
  const ratio = dpr();
  canvas.width = Math.max(1, Math.round(cssW * ratio));
  canvas.height = Math.max(1, Math.round(cssH * ratio));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}
function getXPos(idx) { return idx * colWidth + colWidth / 2; }
function getDirection(angle) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const a = ((angle % 360) + 360) % 360;
  return dirs[Math.round(a / 22.5) % 16];
}
function arrowAngleRad(deg) {
  const norm = (x) => ((x % 360) + 360) % 360;
  let a = norm(deg);
  const tol = 11.25;
  for (const c of [0, 90, 180, 270]) {
    const diff = Math.min(Math.abs(a - c), 360 - Math.abs(a - c));
    if (diff <= tol) { a = c; break; }
  }
  return (a * Math.PI) / 180;
}
function getShortDirectionType(directionType) {
  const raw = (directionType ?? '').toString().trim();
  if (!raw) return { text: '', color: '#666' };
  const lower = raw.toLowerCase().replace(/\s+/g, '-');
  if (/(^|-)onshore($|-)|^on$/.test(lower) || raw.includes('オン')) return { text: 'オン', color: '#e74c3c' };
  if (/(^|-)offshore($|-)|^off$/.test(lower) || raw.includes('オフ')) return { text: 'オフ', color: '#27ae60' };
  if (/(^|-)cross($|-)|(^|-)cross-shore($-)|^side$|(^|-)side-shore($-)/.test(lower) || raw.includes('サイド')) return { text: 'サイド', color: '#f39c12' };
  return { text: raw.slice(0,5), color: '#666' };
}

/* =============== データ受け取り =============== */
export function setTimelinePointName(name = "") {
  timelinePointName = String(name || "");
  try { updateTimelineHeader(); } catch {}
}
window.addEventListener("namiaru:point-change", (e) => {
  setTimelinePointName(e?.detail?.name ?? "");
});

export function setData(rows) {
  rowsAll = Array.isArray(rows) ? rows : [];
  hoursTs = rowsAll.map(r => new Date(r.timestamp));
  hours   = hoursTs.map(d => String(jstYMDHM(d).h).padStart(2,'0'));

  waveHeights = rowsAll.map(r => r.waveHeight);
  tideLevels  = rowsAll.map(r => r.tide);
  windSpeeds  = rowsAll.map(r => r.windSpeed);
  windAngles  = rowsAll.map(r => r.windAngle);
  windDirectionTypes = rowsAll.map(r => r.windDirectionType);
  swellsByHour = rowsAll.map(r => r.swells || []);

  dayDividers = hoursTs
    .map((ts, i) => ({ i, ...jstYMDHM(ts) }))
    .filter(o => o.h === 0)
    .map(o => ({ index: o.i, m: o.m, d: o.d ?? o.day }));

  // ★ JST今日0:00 と 明後日0:00 を求める
  const { startUTC, endUTC } = getJSTWindowUTC(); // [今日0:00, 明後日0:00)
  wave48_indexStart = clampIndex(hoursTs.findIndex(ts => ts >= startUTC));
  wave48_indexEnd   = clampIndex(hoursTs.findIndex(ts => ts >= endUTC));
  if (wave48_indexStart < 0) wave48_indexStart = 0;
  if (wave48_indexEnd   < 0) wave48_indexEnd   = hoursTs.length;
}
function clampIndex(i) { return (i === -1 ? -1 : Math.max(0, Math.min(i, hoursTs.length))); }
function getJSTWindowUTC() {
  const now = new Date();
  // JST「今日」0:00 を UTC で作る（UTC = JST-9h）
  const jstNow = new Date(now.toLocaleString('en-US', { timeZone:'Asia/Tokyo' }));
  const today0UTC = new Date(Date.UTC(jstNow.getFullYear(), jstNow.getMonth(), jstNow.getDate(), -9, 0, 0));
  const after2d0UTC = new Date(today0UTC.getTime() + 48 * 3600 * 1000); // 明後日0:00
  return { startUTC: today0UTC, endUTC: after2d0UTC };
}

/* =============== レイアウト/グリッド =============== */
function setColWidth() { colWidth = 50; }
function drawVerticalGrid(ctx, totalHeight) {
  ctx.strokeStyle = "#f0f0f0";
  ctx.lineWidth = 1;
  for (let i = 0; i <= hours.length; i++) {
    const x = i * colWidth;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, totalHeight); ctx.stroke();
  }
}

//* =============== 波高（数値） =============== */
function drawWaveValueRow() {
  const height = 28;
  const W = hours.length * colWidth;
  const canvas = document.getElementById("waveValueCanvas");
  if (!canvas) return;

  const ctx = setupHiDPICanvas(canvas, W, height);
  ctx.fillStyle = "#333";
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";

  const y = Math.round(height / 2) + 4;

  // ★ 常に全区間を描画（見せない範囲は waveMask で隠す）
  const start = 0;
  const end   = hours.length;

  for (let idx = start; idx < end; idx++) {
    const v = waveHeights[idx];
    if (!Number.isFinite(v)) continue;          // 欠損は描かない
    const x = getXPos(idx);
    const label = Math.floor(v * 10) / 10;      // 0.1刻み
    ctx.fillText(label, x, y);
  }
}

/* =============== 波高（バー） =============== */
function drawWaveBars() {
  const height = 130;
  const W = hours.length * colWidth;
  const canvas = document.getElementById("waveTideCanvas");
  if (!canvas) return;

  const ctx = setupHiDPICanvas(canvas, W, height);
  drawVerticalGrid(ctx, height);

  const maxWave = 2;
  const baseY = height;
  const barW = colWidth * 0.7;
  const radius = 4;

  // ★ 常に全区間を描画（見せない範囲は waveMask で隠す）
  const start = 0;
  const end   = hours.length;

  for (let i = start; i < end; i++) {
    const raw = waveHeights[i];
    if (!Number.isFinite(raw)) continue;        // 欠損は描かない
    const val = Math.max(0, raw);
    const capped = Math.min(val, maxWave);

    const h = (capped / maxWave) * height;
    const x = getXPos(i);
    const y = baseY - h;

    const g = ctx.createLinearGradient(0, y, 0, baseY);
    if (val > 2) { g.addColorStop(0,"#2a7d9eff"); g.addColorStop(1,"#14505f"); }
    else         { g.addColorStop(0,"#65c8e6ff"); g.addColorStop(1,"#227b8e"); }
    ctx.fillStyle = g;

    ctx.beginPath();
    ctx.moveTo(x - barW/2, y + radius);
    ctx.lineTo(x - barW/2, baseY - radius);
    ctx.quadraticCurveTo(x - barW/2, baseY, x - barW/2 + radius, baseY);
    ctx.lineTo(x + barW/2 - radius, baseY);
    ctx.quadraticCurveTo(x + barW/2, baseY, x + barW/2, baseY - radius);
    ctx.lineTo(x + barW/2, y + radius);
    ctx.quadraticCurveTo(x + barW/2, y, x + barW/2 - radius, y);
    ctx.lineTo(x - barW/2 + radius, y);
    ctx.quadraticCurveTo(x - barW/2, y, x - barW/2, y + radius);
    ctx.closePath();
    ctx.fill();
  }
}


/* =============== 潮汐（塗り+線：フル） =============== */
/* =============== 潮汐（縦幅拡張・メモリ線なし） =============== */
function drawTideLine() {
  const canvas = document.getElementById("tideLineCanvas");
  if (!canvas) return;

  // 縦幅を任意に拡張（例: 200px）— 数値は好みで調整してください
  const TIDE_CANVAS_PX = 200;
  canvas.style.height = TIDE_CANVAS_PX + "px";

  const H = TIDE_CANVAS_PX;
  const W = hours.length * colWidth;
  const ctx = setupHiDPICanvas(canvas, W, H);

  ctx.clearRect(0, 0, W, H);

  // 縦の時間グリッド（必要なければこの行を消してください）
  if (typeof drawVerticalGrid === "function") drawVerticalGrid(ctx, H);

  // 余白（上/下）
  const topMargin    = Math.min(Math.max(12, H * 0.10), 48);
  const bottomMargin = 12;
  const minY = topMargin;
  const maxY = H - bottomMargin;

  // 値（安全化）
  const values = (tideLevels || []).map(v => Number.isFinite(v) ? v : 0);
  if (!values.length) return;

  // 自動スケール（最小〜最大にパディングを足す）
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);

  const pad = Math.max((vMax - vMin) * 0.15, 0.10); // 15% or 最低10cm
  let dMin = Math.floor((vMin - pad) * 10) / 10;    // 0.1m刻み丸め
  let dMax = Math.ceil ((vMax + pad) * 10) / 10;

  // 最低スパン確保
  const MIN_SPAN = 0.6;
  if ((dMax - dMin) < MIN_SPAN) {
    const c = (dMax + dMin) / 2;
    dMin = c - MIN_SPAN / 2;
    dMax = c + MIN_SPAN / 2;
  }

  const span = dMax - dMin;
  const yScale = v => {
    const t = (v - dMin) / span;
    const clamped = t < 0 ? 0 : (t > 1 ? 1 : t);
    return maxY - clamped * (maxY - minY);
  };

  // ===== 面（塗り） =====
  ctx.beginPath();
  let prevX, prevY;
  for (let i = 0; i < values.length; i++) {
    const x = getXPos(i);
    const y = yScale(values[i]);
    if (i === 0) ctx.moveTo(x, y);
    else {
      const cp1x = prevX + colWidth / 2,  cp1y = prevY;
      const cp2x = x     - colWidth / 2,  cp2y = y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    prevX = x; prevY = y;
  }
  ctx.lineTo(W, maxY);
  ctx.lineTo(getXPos(0), maxY);
  ctx.closePath();
  ctx.fillStyle = "rgba(151, 174, 184, 0.30)";
  ctx.fill();

  // ===== 線（トレース） =====
  ctx.beginPath();
  prevX = prevY = undefined;
  for (let i = 0; i < values.length; i++) {
    const x = getXPos(i);
    const y = yScale(values[i]);
    if (i === 0) ctx.moveTo(x, y);
    else {
      const cp1x = prevX + colWidth / 30, cp1y = prevY;
      const cp2x = x     - colWidth / 30, cp2y = y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    prevX = x; prevY = y;
  }
  ctx.strokeStyle = "#97aeb8";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // ===== 1日ごとの極値（最小/最大） =====
  const groups = {};
  for (let i = 0; i < hoursTs.length; i++) {
    const { m, day } = jstYMDHM(hoursTs[i]);
    (groups[`${m}-${day}`] ||= []).push(i);
  }

  const extrema = [];
  Object.values(groups).forEach(idxs => {
    let minV = Infinity, maxV = -Infinity, minI = -1, maxI = -1;
    for (const i of idxs) {
      const v = values[i];
      if (v < minV) { minV = v; minI = i; }
      if (v > maxV) { maxV = v; maxI = i; }
    }
    if (maxI >= 0) extrema.push({ kind: "max", idx: maxI, val: values[maxI] });
    if (minI >= 0 && minI !== maxI) extrema.push({ kind: "min", idx: minI, val: values[minI] });
  });

  // 通常点（小丸）
  const skip = new Set(extrema.map(e => e.idx));
  for (let i = 0; i < values.length; i++) {
    if (skip.has(i)) continue;
    const x = getXPos(i), y = yScale(values[i]);
    ctx.fillStyle = "#0099a8";
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }

  // 極値ラベル
  function drawBubble(i, fill, text) {
    const v = values[i] ?? 0;
    const x = getXPos(i);
    const y = yScale(v);
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();

    ctx.fillStyle = text;
    ctx.font = "bold 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    const yy = Math.max(y - 12, minY + 12);
    ctx.fillText(`${v.toFixed(2)}m`, x, yy); // cm表示にしたい場合は (v*100).toFixed(0)+'cm'
  }

  for (const e of extrema) {
    if (e.kind === "max") drawBubble(e.idx, "#e74c3c", "#e74c3c");
    else                  drawBubble(e.idx, "#3498db", "#024978");
  }
}

/* =============== 風（フル） =============== */
function drawWindChart() {
  const H = 90;
  const W = hours.length * colWidth;
  const canvas = document.getElementById("windCanvas");
  if (!canvas) return;
  const ctx = setupHiDPICanvas(canvas, W, H);
  drawVerticalGrid(ctx, H);

  windSpeeds.forEach((val, i) => {
    const x = getXPos(i);
    const deg = windAngles[i] ?? 0;
    const dirText = getDirection(deg);
    const directionType = windDirectionTypes[i];

    ctx.fillStyle = "#333";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${val}`, x, 15);

    ctx.save();
    ctx.translate(x, 35);
    ctx.rotate(arrowAngleRad(deg) + Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 8);
    ctx.moveTo(-4, -6);
    ctx.lineTo(0, -10);
    ctx.lineTo(4, -6);
    ctx.strokeStyle = "#97aeb8";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#555";
    ctx.font = "12px sans-serif";
    ctx.fillText(dirText, x, 65);

    if (directionType) {
      const info = getShortDirectionType(directionType);
      ctx.fillStyle = info.color;
      ctx.font = "bold 10px sans-serif";
      ctx.fillText(info.text, x, H - 2);
    }
  });
}

/* =============== タイムライン & ヘッダー =============== */
function ensureTimelineHeader() {
  const block = document.querySelector('.chart-block');
  if (!block) return null;
  let el = block.querySelector('#timelineHeader');
  if (!el) { el = document.createElement('div'); el.id = 'timelineHeader'; el.className = 'timeline-header'; block.appendChild(el); }
  return el;
}
function updateTimelineHeader() {
  const el = ensureTimelineHeader();
  if (!el || !hoursTs.length) return;

  const first = toJST(hoursTs[0]);
  const last  = toJST(hoursTs[hoursTs.length - 1]);
  const fm = first.getUTCMonth() + 1, fd = first.getUTCDate();
  const lm = last.getUTCMonth() + 1,  ld = last.getUTCDate();
  const rangeText = (fm === lm && fd === ld) ? `${fm}/${fd}` : `${fm}/${fd}~${lm}/${ld}`;

  const block = document.querySelector('.chart-block');
  const point = timelinePointName || block?.dataset?.pointName || "";
  el.textContent = `${point || '—'}　${rangeText}`;

  const axis = document.querySelector('.time-axis');
  if (axis && block) {
    if (getComputedStyle(block).position === 'static') block.style.position = 'relative';
    const b = block.getBoundingClientRect();
    const a = axis.getBoundingClientRect();

    const headerH = el.getBoundingClientRect().height || el.offsetHeight || 0;
    const headerSpace =
      parseFloat(getComputedStyle(document.querySelector('.chart-inner')).paddingTop) || 0;

    const MARGIN = 6; // 余白の中でタイムラインと少し離す
    const top = (a.top - b.top) - headerSpace + (headerSpace - headerH) / 2 - MARGIN;

    el.style.top  = `${top}px`;
    el.style.left = '8px';
    el.style.setProperty('z-index', '100', 'important');
  }
}

/* =============== タイムライン =============== */
function drawTimeAxis() {
  const container = document.getElementById("timeLabels");
  if (!container) return;

  container.innerHTML = "";
  container.style.width = `${hours.length * colWidth}px`;
  container.style.display = "flex";

  const now = new Date();
  const { m:nm, day:nd, h:nh } = jstYMDHM(now);

  hoursTs.forEach((ts) => {
    const { m, day, h } = jstYMDHM(ts);

    const cell = document.createElement("div");
    cell.style.width = `${colWidth}px`;
    cell.style.flexShrink = "0";
    cell.style.textAlign = "center";
    cell.style.display = "flex";
    cell.style.flexDirection = "column";
    cell.style.alignItems = "center";
    cell.style.justifyContent = "center"; // ← 日付を消すので中央寄せに

    // ★ 日付（date-pill）は作らない／表示しない

    const hourBottom = document.createElement("div");
    hourBottom.textContent = String(h).padStart(2, "0");
    hourBottom.className = "hour-label";
    hourBottom.style.fontSize = "11px";
    hourBottom.style.lineHeight = "12px";
    // 00時だけ強調（既存の見た目維持）
    if (h === 0) hourBottom.classList.add("is-zero-hour");
    // 現在時刻の強調
    if (m === nm && day === nd && h === nh) hourBottom.classList.add("current");

    cell.appendChild(hourBottom);
    container.appendChild(cell);
  });
}

/* =============== Overlay & ツールチップ & マスク配置 =============== */
function setupOverlay() {
  // ===== 主要要素の取得 =====
  const overlayCanvas   = document.getElementById("overlayCanvas");         // 交互帯などを描く透明キャンバス
  const ttWave          = document.getElementById("tooltip");               // 波のツールチップ（主TT）
  const chartBlock      = document.querySelector(".chart-block");           // 図全体の外枠
  const scrollContainer = document.querySelector(".chart-scroll-container");// 横スクロール親
  const chartInner      = document.querySelector(".chart-inner");           // コンテンツ内側（座標基準）
  const waveWrapper     = document.getElementById("waveWrapper");           // 波チャートのラッパ（相対配置親）
  let   waveMask        = document.getElementById("waveMask");              // 既存のマスク（class=wave-mask）
  let   lockCard        = document.getElementById("lockCardFixed");         // 案内カード（既存）
  if (!overlayCanvas || !chartInner || !chartBlock || !ttWave || !waveWrapper) return;

  // ===== Z-Index / 定数 =====
  const Z = {
    WRAPPER: 300, OVERLAY: 600, CURSOR: 700,
    ZERO: 745, BADGE: 750,
    WAVE_BACK: 750,            // ★ マスク“背面”に置く層（MASK=800より低い）
    MASK: 800, LOCK: 850, WAVE_FRONT: 900, TIDE_FRONT: 901
  };
  const TOP_OFFSET = 18;
  const BADGE_Y    = 6;
  const BAND_ALPHA = 0.06;
  const ZERO_LINE  = { width:1, color:'rgba(197,197,197,0.9)' };
  const SHOW_TODAY_DATE_PILL = true;

  const COLS = Math.min(
    (hours?.length) || 0,
    (hoursTs?.length) || 0,
    (Array.isArray(tideLevels) ? tideLevels.length : Infinity),
    (Array.isArray(swellsByHour) ? swellsByHour.length : Infinity)
  );
  const totalWidth = (hours?.length || 0) * colWidth;

  // ===== 親の配置保険 =====
  if (getComputedStyle(chartBlock).position   === 'static') chartBlock.style.position   = 'relative';
  if (getComputedStyle(waveWrapper).position  === 'static') waveWrapper.style.position  = 'relative';
  if (getComputedStyle(overlayCanvas).position=== 'static') overlayCanvas.style.position= 'absolute';
  overlayCanvas.style.setProperty('z-index', String(Z.OVERLAY), 'important');
  overlayCanvas.style.pointerEvents = 'auto';

  // TT は chartBlock 直下に置く（座標基準安定のため）
  if (ttWave.parentElement !== chartBlock) chartBlock.appendChild(ttWave);

  // ===== 潮汐ツールチップ（なければ作成） =====
  let ttTide = document.getElementById("tooltipTide");
  if (!ttTide) {
    ttTide = document.createElement('div');
    ttTide.id = 'tooltipTide';
    chartBlock.appendChild(ttTide);
  }
  ttTide.style.setProperty('z-index', String(Z.TIDE_FRONT), 'important');

  // ===== マスクとカードを同じ「maskLayer」に同居させる =====
  let maskLayer = document.getElementById('maskLayer');
  if (!maskLayer) {
    maskLayer = document.createElement('div');
    maskLayer.id = 'maskLayer';
    Object.assign(maskLayer.style, {
      position:'absolute', left:'0', top:'0', width:'0', height:'0',
      zIndex:String(Z.MASK), pointerEvents:'none', display:'none'
    });
    waveWrapper.appendChild(maskLayer);
  }

  // マスクDOMがなければ作成し、maskLayer 配下へ
  if (!waveMask) {
    waveMask = document.createElement('div');
    waveMask.id = 'waveMask';
    waveMask.className = 'wave-mask';
  }
  if (waveMask.parentElement !== maskLayer) maskLayer.appendChild(waveMask);
  Object.assign(waveMask.style, {
    position:'absolute', left:'0', top:'0', width:'100%', height:'100%', pointerEvents:'auto'
  });

  // lockCard を maskLayer 配下に（見た目は後で fixed で配置）
  if (lockCard && lockCard.parentElement !== maskLayer) maskLayer.appendChild(lockCard);
  if (lockCard) Object.assign(lockCard.style, { zIndex:String(Z.LOCK), display:'none' });

  // ===== 日ごとバケット作成（交互帯／日付ピル／0時線 用） =====
  const dayBuckets = [];
  if (Array.isArray(hoursTs) && hoursTs.length) {
    let cur = null;
    hoursTs.forEach((ts, i) => {
      const { m, day } = jstYMDHM(ts);
      const key = `${m}-${day}`;
      if (!cur || cur.key !== key) {
        if (cur) cur.end = i - 1;
        cur = { key, m, d: day, start: i, end: i };
        dayBuckets.push(cur);
      } else cur.end = i;
    });
  }

  // ===== DOM レイヤ（バッジ／0時線） =====
  let badgeLayer = document.getElementById('dateBadgeLayer');
  if (!badgeLayer) {
    badgeLayer = document.createElement('div');
    badgeLayer.id = 'dateBadgeLayer';
    Object.assign(badgeLayer.style, {
      position:'absolute', pointerEvents:'none', zIndex:String(Z.BADGE), left:'0', top:'0'
    });
    chartInner.appendChild(badgeLayer);
  }
  let zeroLayer = document.getElementById('zeroLinesLayer');
  if (!zeroLayer) {
    zeroLayer = document.createElement('div');
    zeroLayer.id = 'zeroLinesLayer';
    Object.assign(zeroLayer.style, {
      position:'absolute', pointerEvents:'none', zIndex:String(Z.ZERO), left:'0', top:'0'
    });
    chartInner.appendChild(zeroLayer);
  }
  const pillBaseCSS = `
    position:absolute; top:${BADGE_Y}px; transform:translateX(-50%);
    padding:2px 6px; border-radius:6px; white-space:nowrap;
    font:700 11px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#fff; color:#222; border:1px solid #bdbdbd;
    box-shadow:0 2px 6px rgba(0,0,0,.06); pointer-events:none;
  `;
  const zeroLineCSS = `
    position:absolute; top:0; width:0; height:100%;
    border-left:${ZERO_LINE.width}px dashed ${ZERO_LINE.color};
    transform:translateX(.5px); pointer-events:none;
  `;

  // ===== ツールチップ初期化（共通見た目を適用） =====
  function initTT(el){ // 用途: ツールチップDOMの基礎スタイル揃え
    const cs = window.getComputedStyle(ttWave);
    Object.assign(el.style, {
      position:'absolute', pointerEvents:'none',
      left:'0px', top:'0px', visibility:'visible', willChange:'left, top, transform'
    });
    el.style.setProperty('display','none','important');
    el.style.background   = cs.backgroundColor || 'rgba(0,0,0,.85)';
    el.style.color        = cs.color || '#fff';
    el.style.padding      = cs.padding || '8px 10px';
    el.style.borderRadius = cs.borderRadius || '4px';
    el.style.fontSize     = cs.fontSize || '13px';
    el.style.lineHeight   = cs.lineHeight || '1.4';
    el.style.boxShadow    = cs.boxShadow || '0 4px 12px rgba(0,0,0,.3)';
    el.style.maxWidth     = cs.maxWidth || '180px';
  }
  initTT(ttWave);
  initTT(ttTide);

  // ===== 交互帯（overlayCanvas に描画） =====
  function drawDayBands(ctx, totalW, totalH){ // 用途: 1日ごとに薄い背景帯を描画
    if (!dayBuckets.length) return;
    ctx.save();
    dayBuckets.forEach((b, idx) => {
      const x0 = getXPos(b.start) - colWidth/2;
      const x1 = getXPos(b.end)   + colWidth/2;
      if (idx % 2 === 0) {
        ctx.fillStyle = `rgba(0,0,0,${BAND_ALPHA})`;
        ctx.fillRect(x0, 0, x1 - x0, totalH);
      }
    });
    ctx.restore();
  }

  // ===== 日付ピル（DOM） =====
  function renderDateBadges(totalW){ // 用途: 日付ピルのDOM生成/配置
    if (!dayBuckets.length) { badgeLayer.innerHTML = ""; return; }
    const today = new Date(); const { m:tm, day:td } = jstYMDHM(today);
    const html = dayBuckets.map((b) => {
      if (!SHOW_TODAY_DATE_PILL && b.m === tm && b.d === td) return '';
      const x = Math.max(2, Math.min(getXPos(b.start), totalW - 2));
      const mm = String(b.m).padStart(2,'0'); const dd = String(b.d).padStart(2,'0');
      return `<span class="date-pill" style="${pillBaseCSS}; left:${x}px">${mm}/${dd}</span>`;
    }).filter(Boolean).join("");
    badgeLayer.innerHTML = html;
  }

  // ===== 0時点線（DOM） =====
  function renderZeroLines(totalW, totalH){ // 用途: 各日の 00:00 の点線DOM
    if (!dayBuckets.length) { zeroLayer.innerHTML = ""; return; }
    const html = dayBuckets.map(b => {
      const x = Math.max(0, Math.min(getXPos(b.start), totalW));
      return `<span class="zero-line" style="${zeroLineCSS}; left:${x}px; height:${totalH}px"></span>`;
    }).join("");
    zeroLayer.innerHTML = html;
  }

  // ===== DOMカーソル（ホバー帯） =====
  let cursor = document.getElementById('overlayCursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'overlayCursor';
    cursor.style.cssText = `position:absolute; top:0; left:0; width:${colWidth}px; height:100%;
      pointer-events:none; z-index:${Z.CURSOR}; will-change:transform,left,top,height;`;
    const band = document.createElement('div');
    band.style.cssText  = `position:absolute; inset:0; background:rgba(155,192,204,0.15);`;
    const line = document.createElement('div');
    line.style.cssText  = `position:absolute; top:0; bottom:0; left:50%; width:0; border-left:2px solid rgba(155,192,204,0.9); transform:translateX(-1px);`;
    cursor.appendChild(band); cursor.appendChild(line);
    chartBlock.appendChild(cursor);
  }

  // ===== LOCK 固定配置（maskLayer 左上をアンカーにして fixed で表示） =====
  // ===== LOCK 固定配置（マスク開始にスナップ → 固定保持） =====
  let lastMaskWidth = 0;

  // 状態を保持：一度“くっついた”ら固定座標を保つ
  let lockAttached = false;
  let lockLeftFixed = 0;

  function positionLockCardFixed(maskWidth){
    if (!lockCard) return;

    // マスク無し/非表示 → LOCKも非表示＆デタッチ
    if (!(maskWidth > 0) || maskLayer.style.display === 'none') {
      lockCard.style.display = 'none';
      lockAttached = false;
      return;
    }

    const pad    = 12;
    const cardW  = Math.min(560, window.innerWidth * 0.92);
    const cardH  = lockCard.offsetHeight || 160;
    const OFFSET_X = 0; // マスク開始にピッタリ

    const ar = maskLayer.getBoundingClientRect();
    if (!ar || ar.width === 0) { lockCard.style.display = 'none'; lockAttached = false; return; }

    // ===== 可視判定（1pxでも見えたら即表示） =====
    const horizontallyVisible = (ar.right > 0) && (ar.left < window.innerWidth);
    const verticallyVisible   = (ar.bottom > 0) && (ar.top  < window.innerHeight);

    if (!(horizontallyVisible && verticallyVisible)) {
      lockCard.style.display = 'none';
      lockAttached = false;
      return;
    }

    // 表示（スナップ & 固定）
    const anchorX = ar.left;      // マスク開始X（そのまま使う＝ズレなし）
    const anchorY = ar.top + pad; // Yは毎フレーム追従

    if (!lockAttached) {
      // ★ クランプしない：表示位置ズレの原因になるため
      //   右端だけは過剰ハミ出し防止（カード全体が右外に飛ぶケース）
      let snapX = Math.round(anchorX + OFFSET_X);
      const maxLeft = window.innerWidth - cardW - pad;
      if (snapX > maxLeft) snapX = maxLeft; // 右にはみ出し過ぎのみ防止（左側は負値OK）

      lockLeftFixed = snapX;
      lockAttached  = true;
    }

    const top = Math.max(pad, Math.min(anchorY, window.innerHeight - cardH - pad));
    Object.assign(lockCard.style, {
      position: 'fixed',
      zIndex: String(Z.LOCK),
      left: `${lockLeftFixed}px`,
      top:  `${top}px`,
      right: 'auto',
      bottom:'auto',
      display: 'block',
      pointerEvents: 'auto'
    });

    // 任意：はみ出し向きフラグ
    if (lockLeftFixed <= -cardW) {
      lockCard.setAttribute('data-offscreen','left');
    } else if (lockLeftFixed >= window.innerWidth - cardW - pad) {
      lockCard.setAttribute('data-offscreen','right');
    } else {
      lockCard.removeAttribute('data-offscreen');
    }
  }

  // ===== レイアウト測定＆反映 =====
  function measureAndSize(){ // 用途: すべてのサイズ/位置を再計算・反映（マスク/カード含む）
    const labelsEl   = document.getElementById("timeLabels");
    const waveCanvas = document.getElementById("waveTideCanvas");
    const tideCanvas = document.getElementById("tideLineCanvas");
    const windCanvas = document.getElementById("windCanvas");
    const valueEl    = document.getElementById("waveValueCanvas");

    const innerRect  = chartInner.getBoundingClientRect();
    const labelsRect = labelsEl?.getBoundingClientRect();
    const waveRect   = waveCanvas?.getBoundingClientRect();
    const tideRect   = tideCanvas?.getBoundingClientRect();
    const windRect   = windCanvas?.getBoundingClientRect();

    const labelsTopWithin = labelsRect ? (labelsRect.top - innerRect.top) : 0;
    const topWithin = Math.max(0, labelsTopWithin - TOP_OFFSET);

    const bottoms = [
      waveRect?.bottom, tideRect?.bottom, windRect?.bottom,
      (valueEl ? valueEl.getBoundingClientRect().bottom : undefined),
      chartInner.getBoundingClientRect().bottom
    ].filter(Number.isFinite);
    const bottomWithin = Math.max(...bottoms) - innerRect.top;
    const totalHeight  = Math.max(1, Math.round(bottomWithin - topWithin + 2));
    const leftWithin   = waveRect ? (waveRect.left - innerRect.left) : 0;

    // overlayCanvas（交互帯）
    overlayCanvas.style.top  = `${topWithin}px`;
    overlayCanvas.style.left = `${leftWithin}px`;
    const ratio = window.devicePixelRatio || 1;
    overlayCanvas.width  = Math.round(totalWidth * ratio);
    overlayCanvas.height = Math.round(totalHeight * ratio);
    overlayCanvas.style.width  = `${totalWidth}px`;
    overlayCanvas.style.height = `${totalHeight}px`;

    const ctx = overlayCanvas.getContext('2d', { alpha:true, desynchronized:true });
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,totalWidth,totalHeight);
    drawDayBands(ctx, totalWidth, totalHeight);

    // バッジ & 0時線
    Object.assign(badgeLayer.style, { top:`${topWithin}px`, left:`0`, width:`${totalWidth}px`, height:`${totalHeight}px` });
    Object.assign(zeroLayer.style,  { top:`${topWithin}px`, left:`0`, width:`${totalWidth}px`, height:`${totalHeight}px` });
    renderDateBadges(totalWidth);
    renderZeroLines(totalWidth, totalHeight);

    // マスク＆ロックカード：maskLayer をマスク領域にジャストフィット
    if (window.PAY_MODE === 'free') {
      const endCenterX  = getXPos(wave48_indexEnd);
      const maskLeftAbs = Math.round(endCenterX - colWidth / 2); // コンテンツ座標（列左端）
      const maskLeftRel = maskLeftAbs - (waveWrapper.offsetLeft || 0);
      const maskWidth   = Math.max(0, (hours.length * colWidth) - maskLeftAbs);

      const vTop = (valueEl?.offsetTop || 0), vH = (valueEl?.clientHeight || 0);
      const wTop = (waveCanvas?.offsetTop || 0), wH = (waveCanvas?.clientHeight || 0);
      const maskTop    = Math.min(vTop, wTop);
      const maskHeight = Math.max(0, Math.max(vTop+vH, wTop+wH) - maskTop);

      Object.assign(maskLayer.style, {
        left:`${maskLeftRel}px`, width:`${maskWidth}px`,
        top:`${maskTop}px`, height:`${maskHeight}px`,
        display:(maskWidth>0 ? 'block' : 'none')
      });

      if (waveMask) waveMask.style.display = (maskWidth>0 ? 'block' : 'none');

      lastMaskWidth = maskWidth;                 // 数値保持
      positionLockCardFixed(maskWidth);          // ★ 画面固定で配置
    } else {
      maskLayer.style.display = 'none';
      if (lockCard) lockCard.style.display = 'none';
    }

    // カーソルの縦位置合わせ
    anchorCursor();
  }

  // ===== カーソルの座標同期 =====
  function anchorCursor(){ // 用途: カーソルDOMを overlayCanvas の矩形に合わせる
    const ov = overlayCanvas.getBoundingClientRect();
    const bl = chartBlock.getBoundingClientRect();
    cursor.style.top    = `${ov.top  - bl.top}px`;
    cursor.style.left   = `${ov.left - bl.left}px`;
    cursor.style.height = `${ov.height}px`;
  }

  // ===== ツールチップ関連 =====
  const showTT = (el)=> el.style.setProperty('display','block','important');
  const hideTT = (el)=> el.style.setProperty('display','none','important');

  const isPaid = (window.PAY_MODE === 'paid');
  function updateZByColumn(col){
    // 用途: マスク前後で波TTの重なり順切替（マスク外=前面、マスク内=背面）
    if (isPaid || !maskLayer) {
      ttWave.style.setProperty('z-index', String(Z.WAVE_FRONT), 'important');
      return;
    }
    const maskedStart = Math.max(0, wave48_indexEnd); // マスク開始列
    const z = (col >= maskedStart) ? Z.WAVE_BACK : Z.WAVE_FRONT; // 背面=Z.WAVE_BACK(750)
    ttWave.style.setProperty('z-index', String(z), 'important');
  }

  function placeTooltipHoriz(el, clientX){
    // 用途: ツールチップの左右位置をブロック内でクランプ
    const cb = chartBlock.getBoundingClientRect();
    const pad = 12; showTT(el);
    const ttRect = el.getBoundingClientRect();
    const relX = clientX - cb.left;
    let left = relX + pad;
    if (relX + ttRect.width + pad > cb.width) left = relX - ttRect.width - pad;
    left = Math.max(pad, Math.min(left, cb.width - ttRect.width - pad));
    el.style.left = `${left}px`;
  }

  function placeTooltipTopFixed(el, anchorRect, fallbackTop=8){
    // 用途: ツールチップの上端位置（固定/クランプ）
    const cb = chartBlock.getBoundingClientRect();
    const pad = 8; const ttr = el.getBoundingClientRect();
    let top = anchorRect ? (anchorRect.top - cb.top) + pad : fallbackTop;
    const maxTop = anchorRect ? (anchorRect.bottom - cb.top) - ttr.height - pad : top;
    if (anchorRect && top > maxTop) top = Math.max(pad, maxTop);
    el.style.top = `${top}px`;
  }

  // ===== マウス移動ハンドラ（1フレーム集約） =====
  let lastCol = -1, pendingX = null, rafFlag = false, overlayRect = null;
  function colFromClientX(x){
    // 用途: クライアントX→列番号
    const r = overlayRect || overlayCanvas.getBoundingClientRect();
    return Math.max(0, Math.min(Math.floor((x - r.left) / colWidth), Math.max(COLS - 1, 0)));
  }

  function schedule(clientX){
    // 用途: ホバー更新（カーソル/TT内容/TT位置/重なり順）
    pendingX = clientX;
    if (rafFlag) return;
    rafFlag = true;
    requestAnimationFrame(() => {
      rafFlag = false;
      if (pendingX == null) return;
      overlayRect = overlayCanvas.getBoundingClientRect();
      anchorCursor();

      const col = colFromClientX(pendingX);
      const xLeft = getXPos(col) - colWidth/2;
      cursor.style.transform = `translateX(${xLeft}px)`;

      if (col !== lastCol){
        // ===== ツールチップ内容構築 =====
        const labelHTML=(i)=>{
          const ts = hoursTs && hoursTs[i]; if (!ts) return `<strong>—</strong>`;
          const { m, day, h } = jstYMDHM(ts);
          const nowJ = jstYMDHM(new Date());
          return (m===nowJ.m && day===nowJ.day && h===nowJ.h)
            ? `<strong>${m}/${day} NOW</strong>`
            : `<strong>${m}/${day} ${String(h).padStart(2,'0')}時</strong>`;
        };
        const buildSwellsHTML=(i)=>{
          const cs = (swellsByHour && swellsByHour[i]) || [];
          if (!cs.length) return `<div class="tt-swells" style="margin-top:6px"><div class="tt-sub" style="font-weight:700;margin-bottom:4px">Swells</div><div style="opacity:.6">—</div></div>`;
          const rows = cs.map((s, k)=>{
            const h = Number.isFinite(+s.height) ? (+s.height).toFixed(2) : '0.00';
            const p = Number.isFinite(+s.period) ? (+s.period).toFixed(1) : '0.0';
            const d = Math.round(+s.direction || 0);
            const dir = getDirection(d); const rot = arrowAngleRad(d) + Math.PI;
            return `<tr><td style="opacity:.6;padding-right:8px">#${k+1}</td><td style="padding-right:10px"><b>${h}</b> m</td><td style="padding-right:10px"><b>${p}</b> s</td><td>${dir}<span style="display:inline-block;margin-left:4px;transform:rotate(${rot}rad)">↑</span></td></tr>`;
          }).join("");
          return `<div class="tt-swells" style="margin-top:6px"><div class="tt-sub" style="font-weight:700;margin-bottom:4px">Swells</div><table style="border-collapse:collapse;font-size:12px">${rows}</table></div>`;
        };
        const waveTooltipHTML=(i)=> `${labelHTML(i)}${buildSwellsHTML(i)}`;
        const tideTooltipHTML=(i)=> {
          const tRaw = tideLevels && tideLevels[i];
          const t = Number.isFinite(tRaw) ? tRaw : 0;
          return `${labelHTML(i)}<div class="tt-tide" style="margin-top:6px"><div class="tt-sub" style="font-weight:700;margin-bottom:4px">潮汐</div><div><b>${t.toFixed(2)}</b> m</div></div>`;
        };

        ttWave.innerHTML = waveTooltipHTML(col);
        ttTide.innerHTML = tideTooltipHTML(col);

        updateZByColumn(col); // ← ここで前面/背面を決定
        lastCol = col;
      }

      // ===== ツールチップの位置更新 =====
      placeTooltipHoriz(ttWave, pendingX);
      placeTooltipTopFixed(ttWave, document.getElementById("waveTideCanvas")?.getBoundingClientRect());
      placeTooltipHoriz(ttTide, pendingX);
      placeTooltipTopFixed(ttTide, document.getElementById("tideLineCanvas")?.getBoundingClientRect(), 8);
    });
  }

  // ===== イベント登録 =====
  overlayCanvas.addEventListener('mousemove', (e)=> schedule(e.clientX));
  overlayCanvas.addEventListener('mouseenter', ()=>{ showTT(ttWave); showTT(ttTide); });
  overlayCanvas.addEventListener('mouseleave', ()=>{ hideTT(ttWave); hideTT(ttTide); pendingX=null; });

  // ★ maskLayer は pointer-events:none なので waveMask に付ける
  if (waveMask) {
    waveMask.addEventListener('mousemove', (e)=> schedule(e.clientX));
    waveMask.addEventListener('mouseenter', ()=>{ showTT(ttWave); showTT(ttTide); });
    waveMask.addEventListener('mouseleave', ()=>{ hideTT(ttWave); hideTT(ttTide); pendingX=null; });
  }

  chartBlock.addEventListener('mousemove', (e)=> schedule(e.clientX));
  chartBlock.addEventListener('mouseleave', ()=>{ hideTT(ttWave); hideTT(ttTide); pendingX=null; });

  // ===== リフロー（画面サイズや横スクロールで再配置） =====
  const reflow = ()=>{
    measureAndSize();
    overlayRect = overlayCanvas.getBoundingClientRect();
    anchorCursor();
    if (window.PAY_MODE === 'free') positionLockCardFixed(lastMaskWidth);
  };
  window.addEventListener('resize', reflow, { passive:true });
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', ()=>{
      overlayRect = overlayCanvas.getBoundingClientRect();
      anchorCursor();
      if (window.PAY_MODE === 'free') positionLockCardFixed(lastMaskWidth);
    }, { passive:true });
  }

  // ===== 初期表示 =====
  measureAndSize();

  const now = new Date();
  const { m:cm, day:cd, h:ch } = jstYMDHM(now);
  let nowCol = hoursTs.findIndex(ts => { const { m, day, h } = jstYMDHM(ts); return m===cm && day===cd && h===ch; });
  if (nowCol < 0) nowCol = 0;

  // 初期の前面/背面も正しくしておく
  updateZByColumn(Math.min(nowCol, Math.max(COLS - 1, 0)));

  if (scrollContainer) {
    const safeCol = Math.min(nowCol, Math.max(COLS - 1, 0));
    scrollContainer.scrollLeft = Math.max(safeCol * colWidth - scrollContainer.clientWidth / 2, 0);
  }

  const ovRect = overlayCanvas.getBoundingClientRect();
  cursor.style.transform = `translateX(${getXPos(nowCol) - colWidth/2}px)`;
  schedule(ovRect.left + Math.min(nowCol, Math.max(COLS - 1, 0)) * colWidth + 1);
}


/* =============== メイン描画 =============== */
export function drawAllCharts() {
  const chartInner = document.querySelector(".chart-inner");
  if (chartInner) chartInner.style.width = `${hours.length * colWidth}px`;
  drawTimeAxis();

  // 波高：無料は「今日0:00〜明日23:00」の48hのみ
  drawWaveValueRow();
  drawWaveBars();

  // 潮汐・風はフル
  drawTideLine();
  drawWindChart();

  // オーバーレイ＆マスク配置
  setupOverlay();
  updateTimelineHeader();
}

/* =============== ライフサイクル =============== */
window.addEventListener("resize", () => { setColWidth(); drawAllCharts(); });
window.addEventListener("load",   () => { setColWidth(); drawAllCharts(); });
