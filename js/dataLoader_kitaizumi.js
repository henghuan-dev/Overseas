// dataLoader_kitaizumi.js — ローダは“常にフル期間”を返す（フィルタはオプション）
// 返却フィールドは既存互換：timestamp(UTC ISO), hour, waveHeight, tide, windSpeed(m/s),
// windAngle, windDirectionType, temp, weatherIcon, swells[], waveHeightDisplay(1桁)

/* ================= ユーティリティ ================= */

// 角括弧/波括弧の中にあるカンマでは分割しない安全なスプリッタ
function smartSplit(line) {
  const out = []; let cur = ""; let depth = 0; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') { inQuotes = !inQuotes; cur += ch; continue; }
    if (!inQuotes) {
      if (ch === "[" || ch === "{") { depth++; cur += ch; continue; }
      if (ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); cur += ch; continue; }
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// 両端のダブルクォートを剥がす
function unquote(s) {
  if (s == null) return "";
  const t = String(s).trim();
  return (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
}

// 小数1桁へ切り捨て
function floorTo1(n) { if (!Number.isFinite(n)) return 0; return Math.floor(n * 10) / 10; }

// JST→UTC Date（JST=UTC+9 → 時差 -9h）
function jstToUTCDate(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm, ss, 0));
}

// "YYYY-MM-DD HH:mm:ss"（JST想定）→ UTC Date
function parseTimestampAsJST(tsStr) {
  const [datePart, timePart = "00:00:00"] = String(tsStr).trim().split(" ");
  const [Y, M, D] = datePart.split("-").map(n => parseInt(n, 10));
  const [h, mi, s] = timePart.split(":").map(n => parseInt(n, 10));
  return jstToUTCDate(Y, M, D, h || 0, mi || 0, s || 0);
}

// swells(JSON/疑似JSON/HTMLエスケープ) を安全に配列へ
function parseSwellsField(raw) {
  if (!raw) return [];
  let t = unquote(String(raw))
    .replace(/&quot;|&#34;/g, '"')
    .replace(/\\"/g, '"')
    .trim();

  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? arr : [];
  } catch {}

  // 単一引用やキーにクォート無しの簡易補正
  try {
    const fixed = t
      .replace(/([{,]\s*)'([^']+?)'(\s*:)/g, '$1"$2"$3') // 'key': → "key":
      .replace(/:\s*'([^']*)'/g, ':"$1"')                 // : 'val' → :"val"
      .replace(/([{,]\s*)([a-zA-Z_]\w*)(\s*:)/g, '$1"$2"$3'); // key: → "key":
    const arr = JSON.parse(fixed);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/* ================= フィルタ（任意） ================= */

// オプションで時間ウィンドウを指定できる。指定がなければ“全行”返す。
function inWindow(ts, opt) {
  if (!opt) return true;
  const t = ts.getTime();

  // 固定ウィンドウ（JST日付で指定）
  if (opt.fixedWindowJST) {
    const { startJST, endJST } = opt.fixedWindowJST;
    if (startJST && endJST) {
      const s = jstToUTCDate(startJST.y, startJST.m, startJST.d, startJST.hh || 0, startJST.mm || 0, 0).getTime();
      const e = jstToUTCDate(endJST.y,   endJST.m,   endJST.d,   endJST.hh   || 0, endJST.mm   || 0, 0).getTime();
      return t >= s && t < e;
    }
  }

  // “今日のJST 0:00 から hours 分だけ”
  if (Number.isFinite(opt.windowHours) && opt.windowHours > 0) {
    const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const baseUTC = Date.UTC(jstNow.getFullYear(), jstNow.getMonth(), jstNow.getDate(), -9, 0, 0, 0);
    const start = baseUTC;
    const end   = baseUTC + opt.windowHours * 3600 * 1000;
    return t >= start && t < end;
  }

  return true;
}

/* ================= メイン ================= */

export async function loadSurfData(csvPath, options = {}) {
  const fetchOpts = options.fetchOptions || {};
  const res = await fetch(csvPath, fetchOpts);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];

  const headers = smartSplit(lines[0]).map(h => unquote(h));
  const idx = {
    timestamp:     headers.findIndex(h => /timestamp/i.test(h)),
    temperature:   headers.findIndex(h => /temperature|temp/i.test(h)),
    condition:     headers.findIndex(h => /condition|weather/i.test(h)),
    tideHeight:    headers.findIndex(h => /height|tide/i.test(h)),   // 潮位（height列想定）
    windSpeedKph:  headers.findIndex(h => /speed|wind.*kph|windSpeed/i.test(h)),
    windAngle:     headers.findIndex(h => /direction(?!Type)/i.test(h)),
    directionType: headers.findIndex(h => /directionType/i.test(h)),
    swells:        headers.findIndex(h => /swells/i.test(h)),
  };
  if (idx.timestamp === -1) {
    console.error("timestamp カラムが見つかりません");
    return [];
  }

  const rows = [];
  for (const rawLine of lines.slice(1)) {
    if (!rawLine.trim()) continue;
    const cols = smartSplit(rawLine).map(unquote);

    const tsStr = cols[idx.timestamp];
    if (!tsStr) continue;

    // JST文字列としてパース → UTC Date
    const ts = parseTimestampAsJST(tsStr);
    if (!Number.isFinite(ts.getTime())) continue;

    // オプションのウィンドウに収まる行だけ採用（既定は“無条件で採用”）
    if (!inWindow(ts, options.window)) continue;

    const [dateStr, timeStr = "00:00:00"] = String(tsStr).split(" ");
    const hour = parseInt(timeStr.split(":")[0] || "0", 10);

    // 風速（KPH→m/s）
    const windMps = (() => {
      const kphRaw = idx.windSpeedKph >= 0 ? parseFloat(cols[idx.windSpeedKph]) : NaN;
      if (Number.isFinite(kphRaw)) return Math.round((kphRaw / 3.6) * 10) / 10;
      return 0;
    })();

    const temp = (() => {
      const t = idx.temperature >= 0 ? parseFloat(cols[idx.temperature]) : NaN;
      return Number.isFinite(t) ? Math.round(t * 10) / 10 : 0;
    })();

    const tide = (() => {
      const h = idx.tideHeight >= 0 ? parseFloat(cols[idx.tideHeight]) : NaN;
      return Number.isFinite(h) ? h : 0;
    })();

    const weatherIcon = idx.condition >= 0 ? (cols[idx.condition] || "").trim() : "";

    // Swells
    const swellsArr = parseSwellsField(idx.swells >= 0 ? cols[idx.swells] : "");
    const swells = swellsArr
      .filter(s => (+s?.height || 0) > 0)
      .map(s => ({
        height: +s.height || 0,
        period: +s.period || 0,
        direction: +s.direction || 0,
      }));

    // 波高：swellsの最大height（メートル）を採用
    const maxSwellHeight = swells.length ? Math.max(...swells.map(s => +s.height || 0)) : 0;
    const waveHeight = Number.isFinite(maxSwellHeight) ? maxSwellHeight : 0;

    rows.push({
      hour,
      waveHeight,
      waveHeightDisplay: floorTo1(waveHeight),
      tide,
      windSpeed: windMps,
      windAngle: idx.windAngle >= 0 ? (parseFloat(cols[idx.windAngle]) || 0) : 0,
      windDirectionType: idx.directionType >= 0 ? (cols[idx.directionType] || "").trim() : "",
      temp,
      weatherIcon,
      swells,
      timestamp: ts.toISOString(), // UTC ISO
      dateStr,
      timeStr,
    });
  }

  // 時刻順に整列（昇順）
  rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return rows;
}

/* ============== 使い方メモ（呼び出し側・例） =================
import { loadSurfData } from './js/dataLoader_kitaizumi.js';

// 既定は“フル期間”を返す（chart_kitaizumi.html が48hのUIロックを適用）
const data = await loadSurfData(csvPath, { fetchOptions:{ cache:'no-store' } });

// もしローダ側で範囲を絞りたい場合（任意・使わなくてOK）:
// A) 今日JST 0:00 から 48時間だけ:
await loadSurfData(csvPath, { window:{ windowHours:48 } });
// B) 固定のJSTウィンドウ:
await loadSurfData(csvPath, { window:{ fixedWindowJST:{ startJST:{y:2025,m:10,d:7}, endJST:{y:2025,m:10,d:9} } } });
============================================================== */
