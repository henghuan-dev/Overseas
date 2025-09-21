// draw.js — 波・潮汐・風チャート + ツールチップ（swells対応・矢印補正あり）

let hours = [], waveHeights = [], tideLevels = [], windSpeeds = [], windAngles = [], windDirectionTypes = [], temps = [], weatherIcons = [], swellsByHour = [];
// ▼ 先頭付近に追加
let timelinePointName = "";

// 外部からポイント名を設定（即反映）
export function setTimelinePointName(name = "") {
  timelinePointName = String(name);
  try { updateTimelineHeader(); } catch (_) {}
}

// カスタムイベントでの通知を受け取る
window.addEventListener("namiaru:point-change", (e) => {
  const name = e?.detail?.name ?? "";
  setTimelinePointName(name);
});

function setData(data) {
  hours = data.map((_, i) => `${i}`);
  waveHeights = data.map(d => d.waveHeight);
  tideLevels  = data.map(d => d.tide);
  windSpeeds  = data.map(d => d.windSpeed);
  windAngles  = data.map(d => d.windAngle);
  windDirectionTypes = data.map(d => d.windDirectionType);
  temps       = data.map(d => d.temp);
  weatherIcons= data.map(d => `https://wa.cdn-surfline.com/quiver/0.21.2/weathericons/${d.weatherIcon}.svg`);
  swellsByHour= data.map(d => d.swells || []); // height=0は dataLoader 側で除外想定
}

let colWidth;
function setColWidth() {
  if (window.innerWidth <= 768) {
    colWidth = 50;
  } else {
    const el = document.querySelector(".chart-scroll-container");
    const containerWidth = el ? el.clientWidth : window.innerWidth;
    colWidth = hours.length ? (containerWidth / hours.length) : 50;
  }
}

// ==== 座標 ====
function getXPos(idx) {
  return idx * colWidth + colWidth / 2;
}

// ==== HiDPI ====
function setupHiDPICanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ==== 方位 ====
function getDirection(angle) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const a = ((angle % 360) + 360) % 360;
  return dirs[Math.round(a / 22.5) % 16];
}

// カードナル（N/E/S/W）近傍では角度をスナップして見栄えを補正
function arrowAngleRad(deg) {
  const norm = (x) => {
    let a = x % 360;
    if (a < 0) a += 360;
    return a;
  };
  let a = norm(deg);
  const tol = 11.25;          // 許容誤差：16方位の半分
  const cardinals = [0, 90, 180, 270];
  for (const c of cardinals) {
    const diff = Math.min(Math.abs(a - c), 360 - Math.abs(a - c));
    if (diff <= tol) { a = c; break; }
  }
  return (a * Math.PI) / 180;
}

// Onshore/Offshore/Cross(-shore) を「オン/オフ/サイド」に正規化（日本語・表記揺れ対応）
function getShortDirectionType(directionType) {
  const raw = (directionType ?? '').toString().trim();
  if (!raw) return { text: '', color: '#666' };

  const lower = raw.toLowerCase().replace(/\s+/g, '-'); // "Cross shore" → "cross-shore"

  // オン（Onshore系 / on / 日本語）
  if (
    /(^|-)onshore($|-)/.test(lower) || /^on$/.test(lower) ||
    raw.includes('オン') || raw.includes('オンショア')
  ) {
    return { text: 'オン', color: '#e74c3c' };
  }

  // オフ（Offshore系 / off / 日本語）
  if (
    /(^|-)offshore($|-)/.test(lower) || /^off$/.test(lower) ||
    raw.includes('オフ') || raw.includes('オフショア')
  ) {
    return { text: 'オフ', color: '#27ae60' };
  }

  // サイド（Cross(-shore) / Side(-shore) / 日本語）
  if (
    /(^|-)cross($|-)/.test(lower) ||
    /(^|-)cross-shore($|-)/.test(lower) ||
    /^side$/.test(lower) ||
    /(^|-)side-shore($|-)/.test(lower) ||
    raw.includes('サイド')
  ) {
    return { text: 'サイド', color: '#f39c12' };
  }

  return { text: raw.slice(0, 5), color: '#666' };
}

// ==== 表示ユーティリティ ====
const f2 = (n) => (Number.isFinite(+n) ? (+n).toFixed(2) : '0.00');
const f1 = (n) => (Number.isFinite(+n) ? (+n).toFixed(1) : '0.0');
// 深海波近似: period[s] → 波長[m]
function periodToWavelengthMeters(T) {
  const t = +T || 0;
  return 1.56 * t * t;
}

// ==== 背景グリッド ====
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

// ==== 波高（数値行） ====
function drawWaveValueRow() {
  const height = 28;
  const totalWidth = hours.length * colWidth;
  const canvas = document.getElementById("waveValueCanvas");
  const ctx = setupHiDPICanvas(canvas, totalWidth, height);

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

// ==== 波高（バー） ====
function drawWaveBars() {
  const height = 130;
  const totalWidth = hours.length * colWidth;
  const canvas = document.getElementById("waveTideCanvas");
  if (!canvas) return;

  const ctx = setupHiDPICanvas(canvas, totalWidth, height);
  drawVerticalGrid(ctx, height);

  const maxWave = 2; // 固定上限
  const waveBaseY = height;
  const barWidth = colWidth * 0.7;
  const radius = 4;

  waveHeights.forEach((valRaw, idx) => {
    const val = valRaw ?? 0;
    const cappedVal = Math.min(val, maxWave);
    const barH = (cappedVal / maxWave) * height;
    const x = getXPos(idx);
    const y = waveBaseY - barH;

    const gradient = ctx.createLinearGradient(0, y, 0, waveBaseY);
    if (val > 2) {
      gradient.addColorStop(0, "#2a7d9eff");
      gradient.addColorStop(1, "#14505f");
    } else {
      gradient.addColorStop(0, "#65c8e6ff");
      gradient.addColorStop(1, "#227b8e");
    }
    ctx.fillStyle = gradient;

    ctx.beginPath();
    ctx.moveTo(x - barWidth / 2, y + radius);
    ctx.lineTo(x - barWidth / 2, waveBaseY - radius);
    ctx.quadraticCurveTo(x - barWidth / 2, waveBaseY, x - barWidth / 2 + radius, waveBaseY);
    ctx.lineTo(x + barWidth / 2 - radius, waveBaseY);
    ctx.quadraticCurveTo(x + barWidth / 2, waveBaseY, x + barWidth / 2, waveBaseY - radius);
    ctx.lineTo(x + barWidth / 2, y + radius);
    ctx.quadraticCurveTo(x + barWidth / 2, y, x + barWidth / 2 - radius, y);
    ctx.lineTo(x - barWidth / 2 + radius, y);
    ctx.quadraticCurveTo(x - barWidth / 2, y, x - barWidth / 2, y + radius);
    ctx.closePath();
    ctx.fill();
  });
}

// ==== 潮汐（折れ線） ====
function drawTideLine() {
  const canvas = document.getElementById("tideLineCanvas");
  if (!canvas || !Array.isArray(hours) || !Array.isArray(tideLevels)) return;

  const cssH = canvas.clientHeight || 120;
  const totalWidth = hours.length * colWidth;

  const ctx = setupHiDPICanvas(canvas, totalWidth, cssH);
  const W = totalWidth;
  const H = cssH;

  ctx.clearRect(0, 0, W, H);
  drawVerticalGrid(ctx, H);

  const topMargin = Math.min(Math.max(16, H * 0.15), 40);
  const minY = topMargin;
  const maxY = H;
  const maxTide = 2.0;

  const safe = (tideLevels || []).map(v => (Number.isFinite(v) ? v : 0));
  const tideValues = safe.filter(n => Number.isFinite(n));
  const maxVal = tideValues.length ? Math.max(...tideValues) : 0;
  const minVal = tideValues.length ? Math.min(...tideValues) : 0;
  const maxIdx = safe.indexOf(maxVal);
  const minIdx = safe.indexOf(minVal);

  ctx.beginPath();
  ctx.moveTo(0, maxY);

  let prevX = null, prevY = null;
  const points = [];

  safe.forEach((val, i) => {
    const x = getXPos(i);
    const y = maxY - (Math.min(val, maxTide) / maxTide) * (maxY - minY);
    points.push({ x, y, val, i });

    if (i === 0) ctx.lineTo(x, y);
    else {
      const cp1x = prevX + colWidth / 2;
      const cp1y = prevY;
      const cp2x = x - colWidth / 2;
      const cp2y = y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    prevX = x; prevY = y;
  });

  ctx.lineTo(W, maxY);
  ctx.closePath();
  ctx.fillStyle = "rgba(151, 174, 184, 0.30)";
  ctx.fill();

  ctx.beginPath();
  prevX = prevY = null;
  safe.forEach((val, i) => {
    const x = getXPos(i);
    const y = maxY - (Math.min(val, maxTide) / maxTide) * (maxY - minY);
    if (i === 0) ctx.moveTo(x, y);
    else {
      const cp1x = prevX + colWidth / 30;
      const cp1y = prevY;
      const cp2x = x - colWidth / 30;
      const cp2y = y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    prevX = x; prevY = y;
  });
  ctx.strokeStyle = "#97aeb8";
  ctx.lineWidth = 1;
  ctx.stroke();

  points.forEach(({ x, y, i }) => {
    if (i === maxIdx || i === minIdx) return;
    ctx.fillStyle = "#0099a8";
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  points.forEach(({ x, y, val, i }) => {
    if (i === maxIdx) {
      ctx.fillStyle = "#e74c3c";
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#e74c3c"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${(val ?? 0).toFixed(2)}m`, x, Math.max(y - 12, 12));
    }
    if (i === minIdx) {
      ctx.fillStyle = "#3498db";
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#024978"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
      const labelY = Math.max(y - 15, minY + 15);
      ctx.fillText(`${(val ?? 0).toFixed(2)}m`, x, labelY);
    }
  });
}

// ==== 風（風速そのまま・矢印は補正回転） ====
function drawWindChart() {
  const height = 90;
  const totalWidth = hours.length * colWidth;
  const canvas = document.getElementById("windCanvas");
  const ctx = setupHiDPICanvas(canvas, totalWidth, height);
  drawVerticalGrid(ctx, height);

  windSpeeds.forEach((val, idx) => {
    const x = getXPos(idx);
    const deg = windAngles[idx] ?? 0;
    const dirText = getDirection(deg);
    const directionType = windDirectionTypes[idx];

    // 風速（dataLoaderで m/s へ変換済の値をそのまま表示）
    ctx.fillStyle = "#333";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${val}`, x, 15);

    // 矢印（上向き=北。カードナル近傍でスナップ補正）
    ctx.save();
    ctx.translate(x, 35);
    ctx.rotate(arrowAngleRad(deg) + Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, -10);     // 矢頭
    ctx.lineTo(0, 8);       // しっぽ
    ctx.moveTo(-4, -6);     // 矢羽
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
      ctx.fillText(info.text, x, height - 2);
    }
  });
}

// ==== 気温（任意） ====
function drawTempChart() {
  const height = 60;
  const totalWidth = hours.length * colWidth;
  const canvas = document.getElementById("tempCanvas");
  const ctx = setupHiDPICanvas(canvas, totalWidth, height);
  drawVerticalGrid(ctx, height);

  const imageCache = {};
  let loadedImages = 0;
  const totalImages = weatherIcons.length;

  weatherIcons.forEach((iconUrl) => {
    if (!imageCache[iconUrl]) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { imageCache[iconUrl] = img; loadedImages++; if (loadedImages >= totalImages) draw(); };
      img.onerror = () => { loadedImages++; if (loadedImages >= totalImages) draw(); };
      img.src = iconUrl;
    } else {
      loadedImages++;
      if (loadedImages >= totalImages) draw();
    }
  });

  function draw() {
    temps.forEach((val, idx) => {
      const x = getXPos(idx);
      const iconUrl = weatherIcons[idx];
      if (imageCache[iconUrl]) {
        const iconSize = 20;
        ctx.drawImage(imageCache[iconUrl], x - iconSize / 2, 10, iconSize, iconSize);
      }
      ctx.font = "bold 14px sans-serif";
      ctx.fillStyle = "#333";
      ctx.textAlign = "center";
      ctx.fillText(`${val}°`, x, height - 5);
    });
  }
}
// --- タイムライン上の「today, M/D」ピル表示（JST） ---
function ensureTimelineHeader() {
  const block = document.querySelector('.chart-block'); // ← ここが .chart-block であること
  if (!block) return null;

  let el = block.querySelector('#timelineHeader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'timelineHeader';
    el.className = 'timeline-header';
    block.appendChild(el); // ← chart-block 直下に追加（.chart-inner ではない）
  }
  return el;
}

function updateTimelineHeader() {
  const el = ensureTimelineHeader();
  if (!el) return;

  const nowJST = new Date(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
  const m = nowJST.getMonth() + 1;
  const d = nowJST.getDate();

  // .chart-block の data 属性もフォールバックに使えるように
  const block = document.querySelector('.chart-block');
  const fallbackName = block?.dataset?.pointName || "";
  const point = timelinePointName || fallbackName;

  // el.textContent = point ? `伊良湖・ロングビーチ, today, ${m}/${d}` : `today, ${m}/${d}`;
  el.textContent = `伊良湖・ロングビーチ, today, ${m}/${d}`;

  // 位置調整は従来どおり
  const labels = document.getElementById('timeLabels');
  if (labels && block) {
    const blockRect  = block.getBoundingClientRect();
    const labelsRect = labels.getBoundingClientRect();
    const topWithinBlock = labelsRect.top - blockRect.top;
    el.style.top = Math.max(0, topWithinBlock - 15) + 'px';
    el.style.left = '8px';
  }
}
// ==== タイムライン ====
function drawTimeAxis() {
  const container = document.getElementById("timeLabels");
  container.innerHTML = "";
  container.style.width = `${hours.length * colWidth}px`;
  container.style.display = "flex";

  hours.forEach((h) => {
    const label = document.createElement("div");
    label.textContent = h;
    label.style.width = `${colWidth}px`;
    label.style.flexShrink = "0";
    label.style.textAlign = "center";

    const nowHour = new Date(
      new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    ).getHours();
    if (parseInt(h, 10) === nowHour) label.classList.add("current");

    container.appendChild(label);
  });
}

// ==== overlay & tooltip ====
function setupOverlay() {
  const overlayCanvas   = document.getElementById("overlayCanvas");
  const tooltip         = document.getElementById("tooltip");
  const scrollContainer = document.querySelector(".chart-scroll-container");
  const chartInner      = document.querySelector(".chart-inner");
  if (!overlayCanvas || !chartInner) return;

  const totalWidth = hours.length * colWidth;

  // --- 実測して overlay の位置・サイズを反映 ---
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

    // 上端: タイムラインの上
    const topWithin = labelsRect ? (labelsRect.top - innerRect.top) : 0;

    // 下端: 波高/潮汐/風速のうち最も下の bottom（= 余白や見出しも含む実寸）
    const bottoms = [
      waveRect?.bottom,
      tideRect?.bottom,
      windRect?.bottom
    ].filter(v => Number.isFinite(v));
    const bottomWithin = bottoms.length
      ? Math.max(...bottoms) - innerRect.top
      : chartInner.clientHeight;

    // 1px 余裕を見ておく（フォント描画やsubpixelズレのギャップ防止）
    const totalHeight = Math.max(1, Math.round(bottomWithin - topWithin + 1));

    // 左端: 波高キャンバスの左（同一直線のはずだが波高を基準に）
    const leftWithin = waveRect ? (waveRect.left - innerRect.left) : 0;

    overlayCanvas.style.position = "absolute";
    overlayCanvas.style.top  = `${topWithin}px`;
    overlayCanvas.style.left = `${leftWithin}px`;

    // HiDPI対応でキャンバス実サイズをセット
    setupHiDPICanvas(overlayCanvas, totalWidth, totalHeight);

    return { totalHeight };
  }

  // 初回採寸
  const { totalHeight } = measureAndSize();
  const ctxOverlay = overlayCanvas.getContext("2d");

  // --- 縦ガイド描画 ---
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
  }

  // モバイルは現在時刻を中央にスクロール
  const now = new Date(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
  const nowCol = now.getHours();
  if (window.innerWidth <= 768 && scrollContainer) {
    const scrollLeftPos = nowCol * colWidth - scrollContainer.clientWidth / 2;
    scrollContainer.scrollLeft = Math.max(scrollLeftPos, 0);
  }

  drawGuide(nowCol);

  // リサイズ時に再計測（rAFでデバウンス）
  let rafId = 0;
  const onResize = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      measureAndSize();
      drawGuide(nowCol);
    });
  };
  window.addEventListener("resize", onResize, { passive: true });

  // ---- ここから先は既存ロジック（ツールチップなど） ----
  function buildSwellsHTML(index) {
    const comps = swellsByHour[index] || [];
    if (!comps.length) {
      return `
        <div class="tt-swells" style="margin-top:6px">
          <div class="tt-sub" style="font-weight:700;margin-bottom:4px">Swells</div>
          <div style="opacity:.6">—</div>
        </div>`;
    }
    const rows = comps.map((s, i) => {
      const h   = Number.isFinite(+s.height) ? (+s.height).toFixed(2) : '0.00';
      const per = Number.isFinite(+s.period) ? (+s.period).toFixed(1) : '0.0';
      const deg = Math.round(+s.direction || 0);
      const dirTxt = getDirection(deg);
      const rotRad = arrowAngleRad(deg) + Math.PI;
      return `
        <tr>
          <td style="opacity:.6;padding-right:8px">#${i+1}</td>
          <td style="padding-right:10px"><b>${h}</b> m</td>
          <td style="padding-right:10px"><b>${per}</b> s</td>
          <td>${dirTxt}
            <span style="display:inline-block;margin-left:4px;transform:rotate(${rotRad}rad)">↑</span>
          </td>
        </tr>`;
    }).join("");

    return `
      <div class="tt-swells" style="margin-top:6px">
        <div class="tt-sub" style="font-weight:700;margin-bottom:4px">Swells</div>
        <table style="border-collapse:collapse;font-size:12px">${rows}</table>
      </div>`;
  }

  function handleMove(clientX, clientY) {
    const rect = overlayCanvas.getBoundingClientRect();
    const colIndex = Math.floor((clientX - rect.left) / colWidth);
    if (colIndex < 0 || colIndex >= hours.length) return;

    drawGuide(colIndex);

    const now = new Date(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
    const todayJST = `${now.getMonth() + 1}/${now.getDate()}`;

    const label = colIndex === now.getHours()
      ? `<strong>NOW</strong>`
      : `<strong>${todayJST} ${hours[colIndex]}時</strong>`;

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
    if (relX + ttRect.width + pad > cbRect.width) {
      left = relX - ttRect.width - pad;
    }
    left = Math.max(pad, Math.min(left, cbRect.width - ttRect.width - pad));

    // 上下
    const relY = clientY - cbRect.top;
    let top = relY - ttRect.height - 8;
    if (top < Math.max(pad, headerBottomWithinBlock + 6)) {
      top = relY + 12;
    }
    top = Math.max(Math.max(pad, headerBottomWithinBlock + 6),
                   Math.min(top, cbRect.height - ttRect.height - pad));

    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
    tooltip.style.visibility = 'visible';
  }

  overlayCanvas.addEventListener("mousemove", (e) => handleMove(e.clientX, e.clientY));
  overlayCanvas.addEventListener("mouseleave", () => {
    drawGuide(nowCol);
    tooltip.style.display = "none";
  });
  overlayCanvas.addEventListener("touchstart", (e) => {
    if (e.touches.length > 0) handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  overlayCanvas.addEventListener("touchmove", (e) => {
    if (e.touches.length > 0) handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  overlayCanvas.addEventListener("touchend", () => {
    drawGuide(nowCol);
    tooltip.style.display = "none";
  });
}


function drawAllCharts() {
  const chartInner = document.querySelector(".chart-inner");
  if (chartInner) chartInner.style.width = `${hours.length * colWidth}px`;
  drawTimeAxis();
  drawWaveValueRow();
  drawWaveBars();
  drawTideLine();
  drawWindChart();
  // drawTempChart(); // 必要なら有効化
  setupOverlay();
  updateTimelineHeader();
}

window.addEventListener("resize", () => {
  setColWidth();
  drawAllCharts();
});

window.addEventListener("load", () => {
  setColWidth();
  drawAllCharts();
});

export { setData, drawAllCharts };
