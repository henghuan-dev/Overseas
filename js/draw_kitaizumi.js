// draw.js — 横スクロール（PC固定幅）＋ 2行タイムライン（00のみ日付表示）
//            00位置に「破線の縦ルール」と「小さな日付バッジ」をOverlayで描画

/* ================== 状態 ================== */
let hoursTs = [];         // Date(UTC)配列（各コマの実時刻）
let hours = [];           // 表示用の “HH”（JST）
let waveHeights = [];
let tideLevels = [];
let windSpeeds = [];
let windAngles = [];
let windDirectionTypes = [];
let temps = [];
let weatherIcons = [];
let swellsByHour = [];

let timelinePointName = "";
let colWidth = 50;        // PCも固定（横スクロール前提）
let dayDividers = [];     // [{ index, m, d }] 00:00の列を記録

/* =============== ユーティリティ =============== */
const dpr = () => window.devicePixelRatio || 1;
const toJST = (d) => new Date(d.getTime() + 9 * 3600 * 1000);

function jstYMDHM(d) {
  const j = toJST(d);
  const m = j.getUTCMonth() + 1;
  const day = j.getUTCDate();
  const h = j.getUTCHours();
  return { m, day, h };
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

function getXPos(idx) {
  return idx * colWidth + colWidth / 2;
}

function getDirection(angle) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const a = ((angle % 360) + 360) % 360;
  return dirs[Math.round(a / 22.5) % 16];
}

// カードナル近傍の見栄え補正
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

// On/Off/Side の短縮表記
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

function setData(rows) {
  hoursTs = rows.map(r => new Date(r.timestamp));  // UTC基準
  hours   = hoursTs.map(d => String(jstYMDHM(d).h).padStart(2,'0')); // “HH”

  waveHeights = rows.map(r => r.waveHeight);
  tideLevels  = rows.map(r => r.tide);
  windSpeeds  = rows.map(r => r.windSpeed);
  windAngles  = rows.map(r => r.windAngle);
  windDirectionTypes = rows.map(r => r.windDirectionType);
  temps       = rows.map(r => r.temp);
  weatherIcons= rows.map(r => `https://wa.cdn-surfline.com/quiver/0.21.2/weathericons/${r.weatherIcon}.svg`);
  swellsByHour= rows.map(r => r.swells || []);

  // 00:00 の列を拾って記録（Overlayで破線＆バッジを描くため）
  dayDividers = hoursTs
    .map((ts, i) => ({ i, ...jstYMDHM(ts) }))
    .filter(o => o.h === 0)
    .map(o => ({ index: o.i, m: o.m, d: o.day }));
}

/* =============== レイアウト =============== */
// 余白・間隔は既存のまま。PCも固定列幅にして横スクロール。
function setColWidth() { colWidth = 50; }

/* =============== グリッド =============== */
function drawVerticalGrid(ctx, totalHeight) {
  ctx.strokeStyle = "#f0f0f0";
  ctx.lineWidth = 1;
  for (let i = 0; i <= hours.length; i++) {
    const x = i * colWidth;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, totalHeight);
    ctx.stroke();
  }
}

/* =============== 波高（数値） =============== */
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

  waveHeights.forEach((val, idx) => {
    const x = getXPos(idx);
    const label = Math.floor((val ?? 0) * 10) / 10;
    ctx.fillText(label, x, y);
  });
}

/* =============== 波高（バー） =============== */
function drawWaveBars() {
  const height = 130;
  const W = hours.length * colWidth;
  const canvas = document.getElementById("waveTideCanvas");
  if (!canvas) return;

  const ctx = setupHiDPICanvas(canvas, W, height);
  drawVerticalGrid(ctx, height);

  const maxWave = 2; // 上限は固定（必要なら動的に）
  const baseY = height;
  const barW = colWidth * 0.7;
  const radius = 4;

  waveHeights.forEach((raw, i) => {
    const val = Math.max(0, raw ?? 0);
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
  });
}

/* =============== 潮汐（塗り+線）— 日毎に最高/最低を表示 =============== */
function drawTideLine() {
  const canvas = document.getElementById("tideLineCanvas");
  if (!canvas) return;

  const H = canvas.clientHeight || 120;
  const W = hours.length * colWidth;
  const ctx = setupHiDPICanvas(canvas, W, H);

  ctx.clearRect(0, 0, W, H);
  drawVerticalGrid(ctx, H);

  const topMargin = Math.min(Math.max(16, H * 0.15), 40);
  const minY = topMargin;
  const maxY = H;
  const maxTide = 2.0;

  const safe = tideLevels.map(v => (Number.isFinite(v) ? v : 0));

  // ---- 面塗り ----
  ctx.beginPath();
  let prevX = null, prevY = null;
  safe.forEach((val, i) => {
    const x = getXPos(i);
    const y = maxY - (Math.min(val, maxTide) / maxTide) * (maxY - minY);
    if (i === 0) ctx.moveTo(x, y);
    else {
      const cp1x = prevX + colWidth / 2, cp1y = prevY;
      const cp2x = x - colWidth / 2,     cp2y = y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    prevX = x; prevY = y;
  });
  ctx.lineTo(W, maxY);
  ctx.lineTo(getXPos(0), maxY);
  ctx.closePath();
  ctx.fillStyle = "rgba(151, 174, 184, 0.30)";
  ctx.fill();

  // ---- 線 ----
  ctx.beginPath();
  prevX = prevY = null;
  safe.forEach((val, i) => {
    const x = getXPos(i);
    const y = maxY - (Math.min(val, maxTide) / maxTide) * (maxY - minY);
    if (i === 0) ctx.moveTo(x, y);
    else {
      const cp1x = prevX + colWidth / 30, cp1y = prevY;
      const cp2x = x - colWidth / 30,     cp2y = y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    prevX = x; prevY = y;
  });
  ctx.strokeStyle = "#97aeb8";
  ctx.lineWidth = 1;
  ctx.stroke();

  // ====== ここから「日毎の極値」計算 ======
  // hoursTs から JST の (月/日) ごとにインデックスをグループ化
  const groups = {};
  hoursTs.forEach((ts, i) => {
    const { m, day } = jstYMDHM(ts);
    const key = `${m}-${day}`;
    (groups[key] ||= []).push(i);
  });

  // 各日について min/max を抽出
  const extrema = [];                // [{kind:'max'|'min', idx, val}]
  Object.values(groups).forEach(idxs => {
    let minV = Infinity, maxV = -Infinity, minI = -1, maxI = -1;
    idxs.forEach(i => {
      const v = safe[i];
      if (v < minV) { minV = v; minI = i; }
      if (v > maxV) { maxV = v; maxI = i; }
    });
    if (maxI >= 0) extrema.push({ kind: 'max', idx: maxI, val: safe[maxI] });
    // min と max が同じ列なら重複ラベルを避ける（maxのみ出す）
    if (minI >= 0 && minI !== maxI) extrema.push({ kind: 'min', idx: minI, val: safe[minI] });
  });

  // 小さな点（中間点）は、日毎の極値インデックスを除外して描く
  const skip = new Set(extrema.map(e => e.idx));
  safe.forEach((_, i) => {
    if (skip.has(i)) return;
    const x = getXPos(i);
    const y = maxY - (Math.min(safe[i], maxTide) / maxTide) * (maxY - minY);
    ctx.fillStyle = "#0099a8";
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  });

  // 日毎の極値ラベルを描画
  const drawBubble = (i, colorFill, colorText) => {
    const v = safe[i] ?? 0;
    const x = getXPos(i);
    const y = maxY - (Math.min(v, maxTide) / maxTide) * (maxY - minY);
    ctx.fillStyle = colorFill;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();

    ctx.fillStyle = colorText;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";

    // ラベルがつぶれにくいように少し上に
    const yy = Math.max(y - 12, minY + 12);
    ctx.fillText(`${v.toFixed(2)}m`, x, yy);
  };

  extrema.forEach(e => {
    if (e.kind === 'max') drawBubble(e.idx, "#e74c3c", "#e74c3c");
    else                  drawBubble(e.idx, "#3498db", "#024978");
  });
}


/* =============== 風 =============== */
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

    // 風速値（m/s）
    ctx.fillStyle = "#333";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${val}`, x, 15);

    // 矢印
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

    // 16方位
    ctx.fillStyle = "#555";
    ctx.font = "12px sans-serif";
    ctx.fillText(dirText, x, 65);

    // オン/オフ/サイド
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
  if (!el) {
    el = document.createElement('div');
    el.id = 'timelineHeader';
    el.className = 'timeline-header';
    block.appendChild(el);
  }
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
  const fallbackName = block?.dataset?.pointName || "";
  const point = timelinePointName || fallbackName;

  el.textContent = `福島・北泉　${rangeText}`;

  // ヘッダー位置（タイムラベルの少し上）
  const labels = document.getElementById('timeLabels');
  if (labels && block) {
    const cs = window.getComputedStyle(block);
     if (cs.position === 'static') block.style.position = 'relative';
    const b = block.getBoundingClientRect();
    const r = labels.getBoundingClientRect();
    // const topWithin = r.top - b.top;
    // el.style.top = Math.max(0, topWithin - 15) + 'px';
    const topWithin = r.top - b.top;
    // const headerH = el.offsetHeight || 0;
    const GAP = 8; // 好みで 4〜14
    // 最新内容でレイアウトを確定させてから高さを取る
    const headerH = el.getBoundingClientRect().height || el.offsetHeight || 0;
    el.style.top = Math.max(0, topWithin - headerH - GAP) + 'px';
    el.style.left = '8px';
  }
}

// 2行タイムライン：上=日付(00のみ)、下=時刻
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
    cell.style.justifyContent = "flex-start";
    cell.style.paddingTop = "0";

    // 上段：日付（00の列だけ表示 & ピル塗り）
    const dateTop = document.createElement("div");
    dateTop.className = "date-pill";
    dateTop.style.fontSize = "9px";
    dateTop.style.lineHeight = "11px";
    dateTop.style.margin = "0";
    dateTop.style.padding = "0";
    dateTop.textContent = "";
    cell.appendChild(dateTop);

    // 下段：時刻（HH）— 00のみ塗り
    const hourBottom = document.createElement("div");
    hourBottom.textContent = String(h).padStart(2, "0");
    hourBottom.className = "hour-label";
    hourBottom.style.fontSize = "11px";
    hourBottom.style.lineHeight = "12px";
    hourBottom.style.margin = "0";
    hourBottom.style.padding = "0";
    if (h === 0) hourBottom.classList.add("is-zero-hour");
    if (m === nm && day === nd && h === nh) hourBottom.classList.add("current");
    cell.appendChild(hourBottom);

    container.appendChild(cell);
  });
}

/* =============== Overlay & Tooltip（ガイド＋日付ディバイダー） =============== */
function setupOverlay() {
  const BADGE_LIFT = 18; // タイムラインより上に持ち上げる量(px)。好みで 12〜24
  const BADGE_UP   = 0;  // さらに微調整したいときは 2〜6 を入れる
  const overlayCanvas   = document.getElementById("overlayCanvas");
  const tooltip         = document.getElementById("tooltip");
  const scrollContainer = document.querySelector(".chart-scroll-container");
  const chartInner      = document.querySelector(".chart-inner");
  if (!overlayCanvas || !chartInner) return;

  const totalWidth = hours.length * colWidth;

  function measureAndSize() {
    const labelsEl = document.getElementById("timeLabels");
    const waveEl   = document.getElementById("waveTideCanvas");
    const tideEl   = document.getElementById("tideLineCanvas");
    const windEl   = document.getElementById("windCanvas");

    const innerRect  = chartInner.getBoundingClientRect();
    const labelsRect = labelsEl?.getBoundingClientRect();
    const waveRect   = waveEl?.getBoundingClientRect();
    const tideRect   = tideEl?.getBoundingClientRect();
    const windRect   = windEl?.getBoundingClientRect();

    // const topWithin = labelsRect ? (labelsRect.top - innerRect.top) : 0;
    const labelsTopWithin = labelsRect ? (labelsRect.top - innerRect.top) : 0;
    const topWithin = Math.max(0, labelsTopWithin - BADGE_LIFT); // ← 上に持ち上げ
    const bottomWithin = Math.max(
      ...( [waveRect?.bottom, tideRect?.bottom, windRect?.bottom].filter(Number.isFinite) ),
      chartInner.clientHeight
    ) - innerRect.top;

    const totalHeight = Math.max(1, Math.round(bottomWithin - topWithin + 1));
    const leftWithin = waveRect ? (waveRect.left - innerRect.left) : 0;

    overlayCanvas.style.position = "absolute";
    overlayCanvas.style.top  = `${topWithin}px`;
    overlayCanvas.style.left = `${leftWithin}px`;

    setupHiDPICanvas(overlayCanvas, totalWidth, totalHeight);
    // return { totalHeight };
    return { totalHeight, lift: (labelsTopWithin - topWithin) };
  }

  // measureAndSize();
  const { totalHeight, lift } = measureAndSize();
  const ctxOverlay = overlayCanvas.getContext("2d");

  function drawDayDividers() {
    if (!dayDividers.length) return;

    ctxOverlay.save();
    // 破線の縦ルール
    ctxOverlay.setLineDash([4, 3]);
    ctxOverlay.strokeStyle = "#c5c5c5";
    ctxOverlay.lineWidth = 1;

    dayDividers.forEach(({ index, m, d }) => {
      const x = getXPos(index);

      // 縦の破線
      ctxOverlay.beginPath();
      ctxOverlay.moveTo(x, 0);
      ctxOverlay.lineTo(x, overlayCanvas.height);
      ctxOverlay.stroke();

      // 小さな日付バッジ（白地・細い枠・太字）
      const label = `${m}/${d}`;
      const padX = 6, padY = 3;
      ctxOverlay.font = "700 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      const w = Math.ceil(ctxOverlay.measureText(label).width) + padX * 2;
      const h = 18;
      const xLeft = Math.max(2, x - w / 2);
      // const yTop  = 2;
      const yTop  = 20;

      const r = 6;
      ctxOverlay.beginPath();
      ctxOverlay.moveTo(xLeft + r, yTop);
      ctxOverlay.arcTo(xLeft + w, yTop,     xLeft + w, yTop + h, r);
      ctxOverlay.arcTo(xLeft + w, yTop + h, xLeft,     yTop + h, r);
      ctxOverlay.arcTo(xLeft,     yTop + h, xLeft,     yTop,     r);
      ctxOverlay.arcTo(xLeft,     yTop,     xLeft + w, yTop,     r);
      ctxOverlay.closePath();
      ctxOverlay.fillStyle = "#ffffff";
      ctxOverlay.fill();
      ctxOverlay.strokeStyle = "#bdbdbd";
      ctxOverlay.lineWidth = 1;
      ctxOverlay.stroke();

      ctxOverlay.fillStyle = "#222";
      ctxOverlay.textAlign = "center";
      ctxOverlay.textBaseline = "middle";
      ctxOverlay.fillText(label, xLeft + w / 2, yTop + h / 2 + 0.5);
    });

    ctxOverlay.restore();
  }

  function drawGuide(col) {
    ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const x = getXPos(col);
    ctxOverlay.fillStyle = "rgba(155, 192, 204, 0.15)";
    ctxOverlay.fillRect(x - colWidth / 2, 0, colWidth, overlayCanvas.height);
    ctxOverlay.beginPath();
    ctxOverlay.moveTo(x, 0);
    ctxOverlay.lineTo(x, overlayCanvas.height);
    ctxOverlay.strokeStyle = "rgba(155, 192, 204, 0.9)";
    ctxOverlay.lineWidth = 2;
    ctxOverlay.stroke();

    // ガイドの後に日付ディバイダーを重ね描き
    drawDayDividers();
  }

  // 現在列（JST）を探す
  const now = new Date();
  const { m:cm, day:cd, h:ch } = jstYMDHM(now);
  let nowCol = hoursTs.findIndex(ts => {
    const { m, day, h } = jstYMDHM(ts);
    return m === cm && day === cd && h === ch;
  });
  if (nowCol < 0) nowCol = 0;

  // 横スクロールの初期位置：現在列の中央付近
  if (scrollContainer) {
    const scrollLeftPos = nowCol * colWidth - scrollContainer.clientWidth / 2;
    scrollContainer.scrollLeft = Math.max(scrollLeftPos, 0);
  }
  drawGuide(nowCol);

  let rafId = 0;
  const onResize = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      measureAndSize();
      drawGuide(nowCol); // 内部で drawDayDividers() も呼ばれる
    });
  };
  window.addEventListener("resize", onResize, { passive: true });

  function buildSwellsHTML(index) {
    const comps = swellsByHour[index] || [];
    if (!comps.length) {
      return `<div class="tt-swells" style="margin-top:6px"><div class="tt-sub" style="font-weight:700;margin-bottom:4px">Swells</div><div style="opacity:.6">—</div></div>`;
    }
    const rows = comps.map((s, i) => {
      const h   = Number.isFinite(+s.height) ? (+s.height).toFixed(2) : '0.00';
      const per = Number.isFinite(+s.period) ? (+s.period).toFixed(1) : '0.0';
      const deg = Math.round(+s.direction || 0);
      const dirTxt = getDirection(deg);
      const rotRad = arrowAngleRad(deg) + Math.PI;
      return `<tr>
        <td style="opacity:.6;padding-right:8px">#${i+1}</td>
        <td style="padding-right:10px"><b>${h}</b> m</td>
        <td style="padding-right:10px"><b>${per}</b> s</td>
        <td>${dirTxt}<span style="display:inline-block;margin-left:4px;transform:rotate(${rotRad}rad)">↑</span></td>
      </tr>`;
    }).join("");
    return `<div class="tt-swells" style="margin-top:6px"><div class="tt-sub" style="font-weight:700;margin-bottom:4px">Swells</div><table style="border-collapse:collapse;font-size:12px">${rows}</table></div>`;
  }

  function handleMove(clientX, clientY) {
    const rect = overlayCanvas.getBoundingClientRect();
    const colIndex = Math.floor((clientX - rect.left) / colWidth);
    if (colIndex < 0 || colIndex >= hours.length) return;

    drawGuide(colIndex); // 内部でディバイダーも再描画

    // const { m, day, h } = jstYMDHM(hoursTs[colIndex]);
    // const label = `<strong>${m}/${day} ${String(h).padStart(2,'0')}時</strong>`;
    const { m, day, h } = jstYMDHM(hoursTs[colIndex]);
    const nowJ = jstYMDHM(new Date()); // JSTの現在時刻（M, day, h）
    const label =
      (m === nowJ.m && day === nowJ.day && h === nowJ.h)
        ? `<strong>${m}/${day} NOW</strong>`
       : `<strong>${m}/${day} ${String(h).padStart(2,'0')}時</strong>`;
    const swellsHtml = buildSwellsHTML(colIndex);

    tooltip.innerHTML = `${label}${swellsHtml}`;
    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';

    const cbRect = document.querySelector(".chart-block").getBoundingClientRect();
    const ttRect = tooltip.getBoundingClientRect();
    const header = document.getElementById('timelineHeader');
    const headerBottomWithinBlock = header
      ? (header.getBoundingClientRect().bottom - cbRect.top)
      : 0;

    const pad = 12;

    // 左右
    const relX = clientX - cbRect.left;
    let left = relX + pad;
    if (relX + ttRect.width + pad > cbRect.width) left = relX - ttRect.width - pad;
    left = Math.max(pad, Math.min(left, cbRect.width - ttRect.width - pad));

    // 上下
    const relY = clientY - cbRect.top;
    let top = relY - ttRect.height - 8;
    if (top < Math.max(pad, headerBottomWithinBlock + 6)) top = relY + 12;
    top = Math.max(Math.max(pad, headerBottomWithinBlock + 6),
                   Math.min(top, cbRect.height - ttRect.height - pad));

    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
    tooltip.style.visibility = 'visible';
  }

  overlayCanvas.addEventListener("mousemove", (e) => handleMove(e.clientX, e.clientY));
  overlayCanvas.addEventListener("mouseleave", () => {
    // カーソル離脱時は現在列へ戻す
    const now = new Date();
    const { m:cm, day:cd, h:ch } = jstYMDHM(now);
    let nowCol2 = hoursTs.findIndex(ts => {
      const { m, day, h } = jstYMDHM(ts);
      return m === cm && day === cd && h === ch;
    });
    if (nowCol2 < 0) nowCol2 = 0;
    drawGuide(nowCol2);
    tooltip.style.display = "none";
  });
  overlayCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length) handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  overlayCanvas.addEventListener("touchmove",  (e) => {
    if (e.touches.length) handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  overlayCanvas.addEventListener("touchend",   ()  => {
    const now = new Date();
    const { m:cm, day:cd, h:ch } = jstYMDHM(now);
    let nowCol2 = hoursTs.findIndex(ts => {
      const { m, day, h } = jstYMDHM(ts);
      return m === cm && day === cd && h === ch;
    });
    if (nowCol2 < 0) nowCol2 = 0;
    drawGuide(nowCol2);
    tooltip.style.display = "none";
  });
}

/* =============== メイン描画 =============== */
function drawAllCharts() {
  const chartInner = document.querySelector(".chart-inner");
  if (chartInner) chartInner.style.width = `${hours.length * colWidth}px`; // 横スクロール幅
  drawTimeAxis();          // 2行タイムライン（上：00のみ日付）
  drawWaveValueRow();
  drawWaveBars();
  drawTideLine();
  drawWindChart();
  // drawTempChart(); // 必要なら復活
  setupOverlay();         // ← ここで破線＆日付バッジを描く
  updateTimelineHeader();
}

/* =============== ライフサイクル =============== */
window.addEventListener("resize", () => { setColWidth(); drawAllCharts(); });
window.addEventListener("load",   () => { setColWidth(); drawAllCharts(); });

export { setData, drawAllCharts };
