// js/map.js
// Carto Voyager / Carto Dark を使った“モダンUI”版（緑色マーカー対応）
// - ズーム＋/−、ホーム、ダーク切替、スケール表示ボタン（自前UI）
// - 国旗⇄ポイント切替は従来どおり
// - ポイントのマーカーは layers.js の makeGreenMarkerIcon() を使用

import { createClusterOptions, makeFlagIcon, makeGreenMarkerIcon } from './layers.js?v=0.1';

let map, cluster, flagLayer;
let worldBounds = null;  // ← 直近選択国の境界を保持
let homeBounds = null;
const DEFAULT_CENTER = [28, 28];
const DEFAULT_ZOOM   = 1.8;
const CUSTOM_ZOOM_STEPS = Object.freeze([2, 3.5, 5, 6.5, 8, 9.5, 11, 12.5, 14, 16, 18]);
const ZOOM_EPSILON = 1e-3;
let basemapLight, basemapDark, currentTheme = 'light';
let scaleControl = null;
const POINT_ZOOM_THRESHOLD = 5;

/**
 * マップ初期化
 * @param {string} domId
 * @param {object} opts
 *  - center: 初期中心 [lat, lng]
 *  - zoom: 初期ズーム
 *  - dark: true で Carto Dark を初期適用（デフォルト false = Voyager）
 */
export function initMap(domId = 'map', { center = [20, 0], zoom = 8, dark = false } = {}) {
  const minZoom = Math.min(DEFAULT_ZOOM, zoom, ...CUSTOM_ZOOM_STEPS);
  const maxZoom = Math.max(zoom, ...CUSTOM_ZOOM_STEPS, 20);
  // Leaflet標準のズームUIは消して自前UIを重ねる
  // map = L.map(domId, { scrollWheelZoom: true, worldCopyJump: true, zoomControl: false }).setView(center, zoom);
  map = L.map(domId, {
    scrollWheelZoom: true,
    worldCopyJump: true,
    zoomControl: false,
    zoomSnap: 0.1,
    minZoom,
    maxZoom
  }).setView(center, zoom);

  // Carto ベース
  basemapLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains: 'abcd', maxZoom: 20
  });
  basemapDark  = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains: 'abcd', maxZoom: 20
  });

  currentTheme = dark ? 'dark' : 'light';
  (dark ? basemapDark : basemapLight).addTo(map);

  // レイヤ（国旗・クラスタ）
  flagLayer = L.layerGroup().addTo(map);
  cluster   = L.markerClusterGroup(createClusterOptions());
  map.addLayer(cluster);

  // 初期は国旗のみ表示
  map.removeLayer(cluster);
  map.addLayer(flagLayer);

  // 縮尺（Leaflet標準）
  scaleControl = L.control.scale({ imperial: false });
  scaleControl.addTo(map);

  // ズームで国旗⇄ポイント切替
  map.on('zoomend', toggleLayersByZoom);

  // モダンUIを右上に重ねる
  injectModernControls(domId);

  return { map, cluster, flagLayer };
}

/** 国旗⇄ポイントの表示切替 */
function toggleLayersByZoom() {
  if (!map) return;
  const z = map.getZoom();
  if (z >= POINT_ZOOM_THRESHOLD) {
    if (!map.hasLayer(cluster)) map.addLayer(cluster);
    if (map.hasLayer(flagLayer)) map.removeLayer(flagLayer);
  } else {
    if (!map.hasLayer(flagLayer)) map.addLayer(flagLayer);
    if (map.hasLayer(cluster)) map.removeLayer(cluster);
  }
}
function getSortedZoomLevels() {
  const levels = new Set(CUSTOM_ZOOM_STEPS);
  levels.add(DEFAULT_ZOOM);

  if (map) {
    const min = map.getMinZoom?.();
    const max = map.getMaxZoom?.();
    if (Number.isFinite(min)) levels.add(min);
    if (Number.isFinite(max)) levels.add(max);
  }

  return Array.from(levels)
    .filter((z) => Number.isFinite(z))
    .sort((a, b) => a - b);
}

function resolveNextZoomLevel(current, direction) {
  if (!Number.isFinite(current) || !map) return null;

  const levels = getSortedZoomLevels();
  if (!levels.length) return null;

  if (direction > 0) {
    for (const level of levels) {
      if (level - current > ZOOM_EPSILON) {
        const max = map.getMaxZoom?.();
        return Number.isFinite(max) ? Math.min(level, max) : level;
      }
    }
    const max = map.getMaxZoom?.();
    if (Number.isFinite(max) && max - current > ZOOM_EPSILON) return max;
    return null;
  }

  if (direction < 0) {
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i];
      if (current - level > ZOOM_EPSILON) {
        const min = map.getMinZoom?.();
        return Number.isFinite(min) ? Math.max(level, min) : level;
      }
    }
    const min = map.getMinZoom?.();
    if (Number.isFinite(min) && current - min > ZOOM_EPSILON) return min;
    return null;
  }

  return null;
}

function stepZoom(direction) {
  const target = resolveNextZoomLevel(map?.getZoom?.(), direction);
  if (Number.isFinite(target)) {
    map.setZoom(target, { animate: true });
  }
}


/** ───── モダンUI（拡大/縮小/ホーム/ダーク/スケール） ───── */
function injectModernControls(hostId){
  const host = document.getElementById(hostId);
  if (!host) return;

  const wrap = document.createElement('div');
  wrap.className = 'map-controls';
  wrap.innerHTML = `
    <div class="ctrl-group">
      <button class="ctrl-btn" data-act="zoom-in"   aria-label="Zoom in"><span class="ico">＋</span></button>
      <button class="ctrl-btn" data-act="zoom-out"  aria-label="Zoom out"><span class="ico">－</span></button>
      <button class="ctrl-btn" data-act="home"      aria-label="Home"><span class="ico">⌂</span></button>
      <button class="ctrl-btn" data-act="theme"     aria-label="Toggle dark"><span class="ico">◐</span></button>
    </div>
  `;
  host.appendChild(wrap);

  // スケールの簡易表示ピル（視覚的アクセント）
  const scalePill = document.createElement('div');
  scalePill.className = 'scale-pill';
  scalePill.textContent = 'Scale';
  host.appendChild(scalePill);

  wrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('.ctrl-btn'); if (!btn) return;
    const act = btn.dataset.act;
    switch(act){
      // case 'zoom-in':  map.setZoom(map.getZoom()+1, { animate:true }); break;
      // case 'zoom-out': map.setZoom(map.getZoom()-1, { animate:true }); break;
      case 'zoom-in':  stepZoom(1); break;
      case 'zoom-out': stepZoom(-1); break;
      case 'home': {
        // 国旗レイヤを前面に戻す
        if (!map.hasLayer(flagLayer)) map.addLayer(flagLayer);
        if (map.hasLayer(cluster))    map.removeLayer(cluster);
        // 世界境界があればそこへ、なければデフォルトへ
        if (homeBounds) {
          map.flyToBounds(homeBounds, { animate: true, duration: 0.6, padding: [32, 32] });
        } else if (worldBounds) {
          map.flyToBounds(worldBounds, { animate: true, duration: 0.6, padding: [32, 32] });
        } else {
          map.flyTo(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: true, duration: 0.6 });
        }
      }
      case 'theme':    toggleTheme(); break;
    }
  });
}
/**
+ * 直近選択した国のポイント配列から「ホーム」境界を設定
+ * @param {Array<{lat:string|number,lng:string|number}>} points
+ */
export function updateHomeTarget(points=[]){
  const coords = points
    .map(s => [parseFloat(s.lat), parseFloat(s.lng)])
    .filter(([la,ln]) => Number.isFinite(la) && Number.isFinite(ln));
  homeBounds = coords.length ? L.latLngBounds(coords) : null;
}

function toggleTheme(){
  if (!map) return;
  if (currentTheme === 'light'){
    if (map.hasLayer(basemapLight)) map.removeLayer(basemapLight);
    basemapDark.addTo(map);
    currentTheme = 'dark';
  }else{
    if (map.hasLayer(basemapDark)) map.removeLayer(basemapDark);
    basemapLight.addTo(map);
    currentTheme = 'light';
  }
}
export function zoomToRadius(latlng, radiusKm = 100, { animate = true } = {}) {
  if (!map) return;

  const lat = latlng.lat, lng = latlng.lng;
  const earthRadius = 6371; // km

  const dLat = (radiusKm / earthRadius) * (180 / Math.PI);
  const dLng = (radiusKm / earthRadius) * (180 / Math.PI) / Math.cos(lat * Math.PI/180);

  const sw = L.latLng(lat - dLat, lng - dLng);
  const ne = L.latLng(lat + dLat, lng + dLng);
  const bounds = L.latLngBounds(sw, ne);

  map.fitBounds(bounds, { animate, padding: [24,24] });
}

/** ───── データ描画系 ───── */
export function setCountryFlags(points, { onClick } = {}) {
  flagLayer.clearLayers();
  const byRegion = {};
  const flagPositions = [];
  points.forEach(p => {
    const key = (p.region || '').trim();
    if (!key) return;
    (byRegion[key] ??= []).push(p);
  });

  Object.entries(byRegion).forEach(([region, spots]) => {
    // 重心（単純平均）
    let lat = 0, lng = 0, n = 0;
    spots.forEach(s => {
      const la = parseFloat(s.lat), ln = parseFloat(s.lng);
      if (Number.isFinite(la) && Number.isFinite(ln)) { lat += la; lng += ln; n++; }
    });
    if (!n) return;
    lat /= n; lng /= n;

    const cc = (spots[0].country_code || '').toLowerCase();
    if (!cc) return;

    const m = L.marker([lat, lng], { icon: makeFlagIcon(cc) }).addTo(flagLayer);
    m.bindTooltip(region, { direction: 'top', offset: [0, -12], className: 'marker-tooltip' });
    flagPositions.push([lat, lng]);

    m.on('click', () => {
    // 重心を求めて半径100kmでズーム
    // let lat = 0, lng = 0, n = 0;
    // spots.forEach(s => {
    //   const la = parseFloat(s.lat), ln = parseFloat(s.lng);
    //   if (Number.isFinite(la) && Number.isFinite(ln)) { lat += la; lng += ln; n++; }
    // });
    // if (!n) return;
    // zoomToRadius(L.latLng(lat/n, lng/n), 100);
    // toggleLayersByZoom();
    // onClick?.(region, spots);
    updateHomeTarget(spots);
      // 重心を求めて半径100kmでズーム
      let lat = 0, lng = 0, n = 0;
      spots.forEach(s => {
        const la = parseFloat(s.lat), ln = parseFloat(s.lng);
        if (Number.isFinite(la) && Number.isFinite(ln)) { lat += la; lng += ln; n++; }
      });
      if (!n) return;
      zoomToRadius(L.latLng(lat/n, lng/n), 100);
      toggleLayersByZoom();
      onClick?.(region, spots);
    });
  });
  worldBounds = flagPositions.length ? L.latLngBounds(flagPositions) : null;
}

export function setPointMarkers(points, { onClick } = {}) {
  // 安全な文字列化（XSS対策）
  const esc = (v = '') =>
    String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  // 表示名：kana → spot_name → file_name（ハイフン→スペース）
  const nameOf = (s = {}) => {
    if (s.kana && String(s.kana).trim()) return String(s.kana).trim();
    if (s.spot_name && String(s.spot_name).trim()) return String(s.spot_name).trim();
    return String(s.file_name || '').replace(/-/g, ' ').trim();
  };

  cluster.clearLayers();

  (points || []).forEach((s) => {
    const la = Number(s.lat);
    const ln = Number(s.lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;

    const m = L.marker([la, ln], {
      icon: makeGreenMarkerIcon(),
      riseOnHover: true,
    });

    // ツールチップ：常時表示（permanent）／kana優先
    const label = esc(nameOf(s)) || '—';
    m.bindTooltip(`<strong>${label}</strong>`, {
      permanent: true,                 // ★ 常時表示
      direction: 'top',
      offset: [0, -12],
      className: 'marker-tooltip',
      // sticky は不要（常時表示なので）
    }).openTooltip();                  // 念のため即オープン

    // クリックで遷移など
    if (typeof onClick === 'function') {
      m.on('click', () => onClick(s));
      // タッチ端末でもワンタップで発火（ツールチップは常時表示のため処理簡素化）
      m.on('touchend', () => onClick(s));
    }

    cluster.addLayer(m);
  });

  // 現ズームに応じてレイヤ切替（従来仕様を踏襲）
  const z = map.getZoom();
  if (z >= POINT_ZOOM_THRESHOLD) {
    map.addLayer(cluster);
    map.removeLayer(flagLayer);
  } else {
    map.addLayer(flagLayer);
    map.removeLayer(cluster);
  }
}


// ====== ズーム/移動の共通ユーティリティ ======
const _toLatLngs = (points=[]) =>
  points
    .map(s => [Number(s?.lat), Number(s?.lng)])
    .filter(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln));

/**
 * 指定ポイント群が収まるようにマップを移動
 * - 単一点のときは “寄りすぎ防止” のために maxZoom を尊重
 * - もっと寄せたい/引きたい時は呼び出し側で { maxZoom: 12 } 等を指定
 */
export function fitToPoints(
  points,
  {
    animate   = true,
    padding   = [24, 24],
    duration  = 0.7,
    maxZoom   = 11,     // ★ 上限ズーム（寄り過ぎ防止）
    snapSingle= true,   // 単一点なら focusSinglePoint を使う
    singleZoom= 10      // 単一点時の固定ズーム（snapSingle=true のときに使用）
  } = {}
){
  const ll = _toLatLngs(points);
  if (!ll.length) return;

  // 単一点 → 固定ズームで扱いたいケース
  if (ll.length === 1 && snapSingle){
    const [la, ln] = ll[0];
    return focusSinglePoint({ lat: la, lng: ln }, singleZoom, { animate, duration });
  }

  const opts = { padding, maxZoom };
  if (animate) {
    map.flyToBounds(ll, { ...opts, duration });
  } else {
    map.fitBounds(ll, opts);
  }
}

/**
 * 単一点へズーム・パン（固定倍率）
 * - 既定ズーム=10（好みに応じて呼び出し側で変更）
 * - レイヤの付け外しはしない（既存の setPointMarkers / クラスタ表示と干渉しないため）
 * - 任意で“単発マーカーを追加”したいときは addMarker:true を使う
 */
export function focusSinglePoint(
  s,
  zoom = 10,
  {
    animate   = true,
    duration  = 0.7,
    addMarker = false,  // ★ 単発マーカーが必要なときに true
    openPopup = false   // addMarker 時にポップアップを開くか
  } = {}
){
  const la = Number(s?.lat), ln = Number(s?.lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return;

  const latlng = L.latLng(la, ln);
  if (animate) map.flyTo(latlng, zoom, { duration });
  else         map.setView(latlng, zoom);

  // 必要なときだけ“単発の緑マーカー”を置く
  if (addMarker) {
    const m = L.marker(latlng, { icon: makeGreenMarkerIcon() }).addTo(map);
    // 常時ツールチップ派なら popup ではなく tooltip を推奨
    if (openPopup && typeof displayName === 'function') {
      m.bindPopup(String(displayName(s) || '')).openPopup();
    }
    return m;
  }
}

export function getMapInstance() { return map; }

/* ===== ヘルパ ===== */
function displayName(s) {
  if (s.kana)      return s.kana;               // ← kana を最優先
  if (s.spot_name) return toTitle(s.spot_name);
  return 'Unknown';
}
function toTitle(t=''){ return t.replace(/\b\w/g, c => c.toUpperCase()); }
