// dataLoader.js

// ---- swells(JSON文字列) を安全に配列へ ----
function parseSwellsField(raw) {
  if (!raw) return [];
  let t = String(raw).trim();

  // フィールド全体が " .... " で囲まれているCSVケース
  if (t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1);
  }

  // HTMLやCSV由来のエスケープを順にデコード
  t = t
    .replace(/&quot;/g, '"') // HTML
    .replace(/\\"/g, '"')    // バックスラッシュエスケープ
    .replace(/""/g, '"');    // CSV の二重引用符

  // 1回目: そのままJSONとして解釈
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? arr : [];
  } catch {}

  // 2回目: 単引用符で囲まれている要素をダブルクォートに置換して再挑戦
  try {
    const fixed = t.replace(/([{,]\s*)'([^']+?)'(\s*:)/g, '$1"$2"$3')  // キー
                   .replace(/:\s*'([^']*)'/g, ':"$1"');                // 値
    const arr = JSON.parse(fixed);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 角括弧/波括弧の中にあるカンマでは分割しない安全なスプリッタ
function smartSplit(line) {
  const out = [];
  let cur = "";
  let depth = 0; // [ ] と { } のネスト深さ

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === "[" || ch === "{") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      cur += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// 小数1桁へ「切り捨て」する（例: 0.45665 -> 0.4, 1.29 -> 1.2）
function floorTo1(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n * 10) / 10;
}

export async function loadSurfData(csvPath) {
  const res = await fetch(csvPath);
  const text = await res.text();
  const lines = text.trim().split("\n");
  const headers = smartSplit(lines[0]); // ← 安全分割

  // JST 今日の日付（YYYY-MM-DD）
  const nowJST = new Date(new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
  const todayStr =
    `${nowJST.getFullYear()}-${String(nowJST.getMonth() + 1).padStart(2, "0")}-${String(nowJST.getDate()).padStart(2, "0")}`;

  // 必要カラムのインデックス
  const idx = {
    timestamp: headers.indexOf("timestamp"),
    temperature: headers.indexOf("temperature"),
    condition: headers.indexOf("condition"),
    height: headers.indexOf("height"),   // 潮汐（無ければ 0）
    speed: headers.indexOf("speed"),     // KPH
    direction: headers.indexOf("direction"),
    directionType: headers.indexOf("directionType"), // 追加
    swells: headers.indexOf("swells"),
  };

  if (idx.timestamp === -1) {
    console.error("timestamp カラムが見つかりません");
    return [];
  }

  const result = [];

  for (const line of lines.slice(1)) {
    const cols = smartSplit(line);

    const rawTs = cols[idx.timestamp]?.trim?.();
    if (!rawTs) continue;

    // 期待形式: "YYYY-MM-DD HH:mm:ss"
    const [dateStr, timeStr] = rawTs.split(" ");
    if (dateStr !== todayStr) continue; // 今日以外は捨てる

    // 各値
    const obj = {
      temperature: idx.temperature >= 0 ? cols[idx.temperature] : "",
      condition:   idx.condition   >= 0 ? cols[idx.condition]   : "",
      height:      idx.height      >= 0 ? cols[idx.height]      : "",
      speed:       idx.speed       >= 0 ? cols[idx.speed]       : "",
      direction:   idx.direction   >= 0 ? cols[idx.direction]   : "",
      directionType: idx.directionType >= 0 ? cols[idx.directionType] : "", // 追加
      swells:      idx.swells      >= 0 ? cols[idx.swells]      : "",
    };

    // --- swells から最大 height を抽出 ---
    // 文字列中の "height": 0.123 でも 'height': 0.123 でも拾えるように対応
    let maxSwellHeight = 0;
    const swellsRaw = obj.swells?.trim?.();

    if (swellsRaw) {
      const heightMatches = [...swellsRaw.matchAll(/["']?height["']?\s*:\s*([0-9]*\.?[0-9]+)/g)]
        .map(m => parseFloat(m[1]))
        .filter(n => Number.isFinite(n));

      if (heightMatches.length) {
        maxSwellHeight = Math.max(...heightMatches);
      }
    }

    // ---- 風速: KPH → m/s（小数1桁、四捨五入）----
    const windMps = (() => {
      const kph = parseFloat(obj.speed);
      if (Number.isFinite(kph)) return Math.round((kph / 3.6) * 10) / 10;
      return 0;
    })();

    // ---- 気温: 小数1桁（四捨五入）----
    const temp = (() => {
      const t = parseFloat(obj.temperature);
      if (Number.isFinite(t)) return Math.round(t * 10) / 10;
      return 0;
    })();

    // ---- 潮汐: 数値化（無ければ 0）----
    const tide = (() => {
      const h = parseFloat(obj.height);
      return Number.isFinite(h) ? h : 0;
    })();

    // 時
    const hour = parseInt(timeStr.split(":")[0], 10);

    // ✅ 要件：
    //   - waveHeight       : 棒グラフ用の「生の実数」（切り捨て無し）
    //   - waveHeightDisplay: 目盛・ツールチップ表示用の「小数1桁へ切り捨て」
    const waveHeightRaw = Number.isFinite(maxSwellHeight) ? maxSwellHeight : 0;
    const waveHeightDisplay = floorTo1(waveHeightRaw);

    // ---- swells 配列も保持（height>0 のみ）----
    const swells = parseSwellsField(obj.swells)
      .filter(s => (+s?.height || 0) > 0)
      .map(s => ({
        height: +s.height || 0,        // m
        period: +s.period || 0,        // s（後で波長[m]に換算）
        direction: +s.direction || 0,  // deg (0 = North, clockwise)
      }));

    result.push({
      hour,
      waveHeight: waveHeightRaw,
      waveHeightDisplay,
      tide,
      windSpeed: windMps,
      windAngle: parseFloat(obj.direction) || 0,
      windDirectionType: obj.directionType?.trim?.() || "",
      temp,
      weatherIcon: obj.condition?.trim?.() || "",
      swells, // ★ 追加：この時間帯のスウェル成分一覧
    });
  }
  return result;
}
