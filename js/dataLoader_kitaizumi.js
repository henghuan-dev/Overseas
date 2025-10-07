// dataLoader.js — 48hウィンドウ or 固定日付ウィンドウ（JST）
// 既存の戻り値フィールドは維持（hour, waveHeight, tide, windSpeed など）

/* ===== 設定：固定ウィンドウを使うか？ =====
   enabled=true: JSTで startJST〜endJST のみ通す
   enabled=false: 従来の「今日から48h」を使用 */
const FIXED_WINDOW = {
  enabled: true,
  startJST: { y: 2025, m: 10, d: 7 }, // 2025/10/07 00:00 JST から
  endJST:   { y: 2025, m: 10, d: 9 }, // 2025/10/09 00:00 JST まで（10/8を含む）
};

// ---- swells(JSON文字列) を安全に配列へ ----
function parseSwellsField(raw) {
  if (!raw) return [];
  let t = String(raw).trim();
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  t = t.replace(/&quot;/g, '"').replace(/\\"/g, '"').replace(/""/g, '"');
  try { const arr = JSON.parse(t); return Array.isArray(arr) ? arr : []; } catch {}
  try {
    const fixed = t.replace(/([{,]\s*)'([^']+?)'(\s*:)/g, '$1"$2"$3')
                   .replace(/:\s*'([^']*)'/g, ':"$1"');
    const arr = JSON.parse(fixed);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// 角括弧/波括弧の中にあるカンマでは分割しない安全なスプリッタ
function smartSplit(line) {
  const out = []; let cur = ""; let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "[" || ch === "{") { depth++; cur += ch; continue; }
    if (ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// 小数1桁へ切り捨て
function floorTo1(n) { if (!Number.isFinite(n)) return 0; return Math.floor(n * 10) / 10; }

/* ===== JSTユーティリティ ===== */

// JSTの日付を「対応するUTC時刻のDate」に変換（JST=UTC+9 → -9h）
function jstToUTCDate(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, ss, 0));
}

// "YYYY-MM-DD HH:mm:ss"（JST想定）→ 正しいUTC Date
function parseTimestampAsJST(tsStr) {
  const [datePart, timePart = "00:00:00"] = tsStr.trim().split(" ");
  const [Y, M, D] = datePart.split("-").map(n => parseInt(n, 10));
  const [h, mi, s] = timePart.split(":").map(n => parseInt(n, 10));
  return jstToUTCDate(Y, M, D, h || 0, mi || 0, s || 0);
}

// 従来の「当日0:00〜+48h（翌日24:00未満）」判定:contentReference[oaicite:1]{index=1}
function startOfTodayJST() {
  const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jstNow.getFullYear();
  const m = jstNow.getMonth();      // 0-11
  const d = jstNow.getDate();
  return new Date(Date.UTC(y, m, d, -9, 0, 0, 0));
}
function isWithin48hWindowJST(dateObj) {
  const start = startOfTodayJST();
  const end   = new Date(start.getTime() + 48 * 3600 * 1000);
  return dateObj >= start && dateObj < end;
}

// ★ 固定ウィンドウ（JST）判定：10/7〜10/8 を通す（= 10/7 00:00 〜 10/9 00:00 未満）
function isWithinFixedWindowJST(dateObj) {
  const s = jstToUTCDate(FIXED_WINDOW.startJST.y, FIXED_WINDOW.startJST.m, FIXED_WINDOW.startJST.d, 0, 0, 0);
  const e = jstToUTCDate(FIXED_WINDOW.endJST.y,   FIXED_WINDOW.endJST.m,   FIXED_WINDOW.endJST.d,   0, 0, 0);
  return dateObj >= s && dateObj < e;
}

// 実際に使うウィンドウ判定（トグル可能）
function isWithinTargetWindow(dateObj) {
  return FIXED_WINDOW.enabled ? isWithinFixedWindowJST(dateObj) : isWithin48hWindowJST(dateObj);
}

export async function loadSurfData(csvPath) {
  const res = await fetch(csvPath);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (!lines.length) return [];

  const headers = smartSplit(lines[0]); // ← 安全分割
  const idx = {
    timestamp:     headers.indexOf("timestamp"),
    temperature:   headers.indexOf("temperature"),
    condition:     headers.indexOf("condition"),
    height:        headers.indexOf("height"),
    speed:         headers.indexOf("speed"),
    direction:     headers.indexOf("direction"),
    directionType: headers.indexOf("directionType"),
    swells:        headers.indexOf("swells"),
  };
  if (idx.timestamp === -1) { console.error("timestamp カラムが見つかりません"); return []; }

  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = smartSplit(line);
    const rawTs = cols[idx.timestamp]?.trim?.();
    if (!rawTs) continue;

    // JSTとしてパース → UTCのDate
    const ts = parseTimestampAsJST(rawTs);
    if (!isWithinTargetWindow(ts)) continue; // ★ ここだけ差し替え（固定 or 48h）

    const [dateStr, timeStr = "00:00:00"] = rawTs.split(" ");

    const obj = {
      temperature:   idx.temperature   >= 0 ? cols[idx.temperature]   : "",
      condition:     idx.condition     >= 0 ? cols[idx.condition]     : "",
      height:        idx.height        >= 0 ? cols[idx.height]        : "",
      speed:         idx.speed         >= 0 ? cols[idx.speed]         : "",
      direction:     idx.direction     >= 0 ? cols[idx.direction]     : "",
      directionType: idx.directionType >= 0 ? cols[idx.directionType] : "",
      swells:        idx.swells        >= 0 ? cols[idx.swells]        : "",
    };

    // swells 最大height 抽出
    let maxSwellHeight = 0;
    const swellsRaw = obj.swells?.trim?.();
    if (swellsRaw) {
      const heightMatches = [...swellsRaw.matchAll(/["']?height["']?\s*:\s*([0-9]*\.?[0-9]+)/g)]
        .map(m => parseFloat(m[1])).filter(n => Number.isFinite(n));
      if (heightMatches.length) maxSwellHeight = Math.max(...heightMatches);
    }

    // 風速 KPH→m/s（小数1桁、四捨五入）
    const windMps = (() => {
      const kph = parseFloat(obj.speed);
      if (Number.isFinite(kph)) return Math.round((kph / 3.6) * 10) / 10;
      return 0;
    })();

    // 気温 小数1桁（四捨五入）
    const temp = (() => {
      const t = parseFloat(obj.temperature);
      if (Number.isFinite(t)) return Math.round(t * 10) / 10;
      return 0;
    })();

    // 潮汐 数値化
    const tide = (() => {
      const h = parseFloat(obj.height);
      return Number.isFinite(h) ? h : 0;
    })();

    const hour = parseInt((timeStr || "00:00:00").split(":")[0], 10);

    const waveHeightRaw = Number.isFinite(maxSwellHeight) ? maxSwellHeight : 0;
    const waveHeightDisplay = floorTo1(waveHeightRaw);

    const swells = parseSwellsField(obj.swells)
      .filter(s => (+s?.height || 0) > 0)
      .map(s => ({
        height: +s.height || 0,
        period: +s.period || 0,
        direction: +s.direction || 0,
      }));

    rows.push({
      hour,
      waveHeight: waveHeightRaw,
      waveHeightDisplay,
      tide,
      windSpeed: windMps,
      windAngle: parseFloat(obj.direction) || 0,
      windDirectionType: obj.directionType?.trim?.() || "",
      temp,
      weatherIcon: obj.condition?.trim?.() || "",
      swells,
      timestamp: ts.toISOString(),
      dateStr,
      timeStr,
    });
  }

  rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return rows;
}
