// js/map.js
// 統一遷移対応版（Carto Voyager/Dark、国旗⇄ポイント自動切替、緑マーカー）
// - HOME / 「Globeに戻る」は *常に* ハードコードした世界ビュー（HOME_CENTER/HOME_ZOOM）へ戻す
// - 国旗クリック時: onClick が渡されていればズームしない（list.js の gotoRegion に委譲）
// - onClick 未指定時のみ軽い既定ズームを行うフォールバック
// - homeBounds は廃止。worldBounds のみ維持（情報用途）。updateHomeTarget は互換のため no-op。

import { createClusterOptions, makeFlagIcon, makeGreenMarkerIcon } from './layers.js?v=0.1';

let map, cluster, flagLayer;
let worldBounds = null;   // 全国旗重心の外接境界（setCountryFlags 後）— HOME では使用しないが情報として保持

// ── HOME（世界ビュー）をハードコード ────────────────────────────
const HOME_CENTER = [20, 0];
const HOME_ZOOM   = 2.0;

// Leaflet の最小世界表示などの内部ユーティリティ
const CUSTOM_ZOOM_STEPS = Object.freeze([2, 3.5, 5, 6.5, 8, 9.5, 11, 12.5, 14, 16, 18]);
const ZOOM_EPSILON = 1e-3;

let basemapLight, basemapDark, currentTheme = 'light';
let scaleControl = null;
const POINT_ZOOM_THRESHOLD = 5;

// 「Globeに戻る」イベントをページ側に伝えるためのハンドラ（任意）
let onBackToGlobe = null;

/* =========================
 * マップ初期化
 * ========================= */
export function initMap(
  domId = 'map',
  { center = HOME_CENTER, zoom = HOME_ZOOM, dark = false, onBackToGlobe: cb } = {}
) {
  // HOME を基準に min/max を組む
  const minZoom = Math.min(HOME_ZOOM, zoom, ...CUSTOM_ZOOM_STEPS);
  const maxZoom = Math.max(zoom, ...CUSTOM_ZOOM_STEPS, 20);

  onBackToGlobe = typeof cb === 'function' ? cb : null;

  map = L.map(domId, {
    scrollWheelZoom: true,
    worldCopyJump: true,
    zoomControl: false,
    zoomSnap: 0.1,
    minZoom,
    maxZoom
  }).setView(center, zoom);

  // ベースマップ
  basemapLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains: 'abcd', maxZoom: 20
  });
  basemapDark  = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains: 'abcd', maxZoom: 20
  });

  currentTheme = dark ? 'dark' : 'light';
  (dark ? basemapDark : basemapLight).addTo(map);

  // レイヤ
  flagLayer = L.layerGroup().addTo(map);
  cluster   = L.markerClusterGroup(createClusterOptions());
  map.addLayer(cluster);

  // 初期は国旗のみ表示
  map.removeLayer(cluster);
  map.addLayer(flagLayer);

  // 縮尺
  scaleControl = L.control.scale({ imperial: false });
  scaleControl.addTo(map);

  // ズーム閾値で国旗⇄ポイント自動切替
  map.on('zoomend', toggleLayersByZoom);

  // UI（右上）
  injectModernControls(domId);

  // 「Globeに戻る」ボタン検出
  bindBackToGlobeButton(domId);

  return { map, cluster, flagLayer };
}

/* =========================
 * HOME（= 世界ビュー）へ戻る
 * ========================= */
function goHomeWorld() {
  if (!map) return;

  // フラグ表示モードへ強制
  if (!map.hasLayer(flagLayer)) map.addLayer(flagLayer);
  if (map.hasLayer(cluster))    map.removeLayer(cluster);

  // 常に固定の世界ビューへ戻す（fitBounds 等は使わない）
  map.flyTo(L.latLng(HOME_CENTER[0], HOME_CENTER[1]), HOME_ZOOM, {
    animate: true, duration: 0.6, easeLinearity: 0.9
  });
}

/* =========================
 * Globeに戻る（イベント本体）
 * ========================= */
function handleBackToGlobe() {
  try { if (typeof onBackToGlobe === 'function') onBackToGlobe(); } catch(_) {}
  try { goHomeWorld(); } catch(_) {}
}

/** 「Globeに戻る」ボタンの監視/バインド */
function bindBackToGlobeButton(hostId) {
  const host = document.getElementById(hostId) || document;
  const q = () => host.querySelector('[data-ui="back-to-globe"]');

  const attach = () => {
    const btn = q();
    if (!btn) return;
    if (btn._backBound) return;
    btn._backBound = true;

    btn.addEventListener('click', handleBackToGlobe);
    btn.addEventListener('touchend', (e) => { e.preventDefault(); handleBackToGlobe(); }, { passive:false });
  };

  attach();
  new MutationObserver(attach).observe(host, { childList:true, subtree:true, attributes:true });
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

/* ========= ズーム段階ユーティリティ ========= */
function getSortedZoomLevels() {
  const levels = new Set(CUSTOM_ZOOM_STEPS);

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
  if (!Number.isFinite(target)) return;
  const c = map.getCenter();
  map.flyTo(c, target, { duration: .35, easeLinearity: .9 });
}

/* ───── 自前UI（右上縦配置。戻るボタンの下に追従） ───── */
function injectModernControls(hostId){
  const host = document.getElementById(hostId);
  if (!host) return;

  const MAP_TOOLS_MARGIN_BELOW_GLOBE =
    (window && window.MAP_TOOLS_MARGIN_BELOW_GLOBE) ?? 80;

  let wrap = host.querySelector('#map-tools');
  if (!wrap){
    wrap = document.createElement('div');
    wrap.id = 'map-tools';
    wrap.className = 'map-tools';
    wrap.innerHTML = `
      <div class="tools-group">
        <button class="ctrl-btn" data-act="zoom-in"   aria-label="Zoom in"><span class="ico">＋</span></button>
        <button class="ctrl-btn" data-act="zoom-out"  aria-label="Zoom out"><span class="ico">－</span></button>
        <button class="ctrl-btn" data-act="home"      aria-label="Home"><span class="ico">⌂</span></button>
        <button class="ctrl-btn" data-act="theme"     aria-label="Toggle dark"><span class="ico">◐</span></button>
      </div>
    `;
    host.appendChild(wrap);
  }

  Object.assign(wrap.style, {
    position: 'absolute',
    right: '12px',
    top: `${MAP_TOOLS_MARGIN_BELOW_GLOBE}px`,
    zIndex: '650',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    pointerEvents: 'none'
  });

  const grp = wrap.querySelector('.tools-group');
  if (grp){
    Object.assign(grp.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      pointerEvents: 'auto',
      alignItems: 'flex-end'
    });
  }
  wrap.querySelectorAll('.ctrl-btn').forEach(btn=>{
    Object.assign(btn.style, {
      appearance: 'none',
      border: '1px solid rgba(255,255,255,.10)',
      cursor: 'pointer',
      width: '44px', height: '44px',
      borderRadius: '12px',
      background: 'rgba(11,20,36,.92)',
      color: '#e6f0ff',
      fontWeight: '700',
      boxShadow: '0 6px 16px rgba(0,0,0,.35)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    });
  });

  const positionTools = ()=>{
    try{
      const backWrap = host.querySelector('.map-controls');
      if (!backWrap){
        wrap.style.top = `${MAP_TOOLS_MARGIN_BELOW_GLOBE}px`;
        return;
      }
      const hostRect = host.getBoundingClientRect();
      const rect     = backWrap.getBoundingClientRect();
      const topPx = (rect.bottom - hostRect.top) + MAP_TOOLS_MARGIN_BELOW_GLOBE;
      wrap.style.top = `${Math.max(MAP_TOOLS_MARGIN_BELOW_GLOBE, topPx)}px`;
    }catch(_){
      wrap.style.top = `${MAP_TOOLS_MARGIN_BELOW_GLOBE}px`;
    }
  };
  positionTools();
  window.addEventListener('resize', positionTools);
  map.on('zoomend moveend', positionTools);
  new MutationObserver(positionTools).observe(host, { childList:true, subtree:true, attributes:true });

  wrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('.ctrl-btn'); if (!btn) return;
    const act = btn.dataset.act;
    switch(act){
      case 'zoom-in':  stepZoom(1); break;
      case 'zoom-out': stepZoom(-1); break;
      case 'home': {
        // HOME は常に固定世界ビューへ
        goHomeWorld();
        break;
      }
      case 'theme': toggleTheme(); break;
    }
  });
}

/* =========================
 * 互換: 「ホーム更新」は廃止（no-op）
 * ========================= */
export function updateHomeTarget(/* points=[] */){
  // 互換のため残置。homeBounds は廃止済みのため何もしない。
}

/* テーマ切替 */
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

/* =========================
 * データ描画：国旗レイヤ
 * ========================= */
export function setCountryFlags(points, { onClick } = {}) {
  flagLayer.clearLayers();
  const byRegion = new Map();
  const flagPositions = [];

  (points||[]).forEach(p => {
    const key = String(p.region||'').trim();
    if (!key) return;
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(p);
  });

  byRegion.forEach((spots, region) => {
    // 重心（単純平均）
    let lat = 0, lng = 0, n = 0;
    for (const s of spots){
      const la = parseFloat(s.lat), ln = parseFloat(s.lng);
      if (Number.isFinite(la) && Number.isFinite(ln)) { lat += la; lng += ln; n++; }
    }
    if (!n) return;
    lat /= n; lng /= n;

    const cc = (spots[0].country_code || '').toLowerCase();
    if (!cc) return;

    const m = L.marker([lat, lng], { icon: makeFlagIcon(cc) }).addTo(flagLayer);
    m.bindTooltip(region, { direction: 'top', offset: [0, -12], className: 'marker-tooltip' });
    flagPositions.push([lat, lng]);

    // onClick があれば gotoRegion 等へ委譲（ズームしない）
    // onClick が無ければ軽いフォールバックズーム
    m.on('click', () => {
      if (typeof onClick === 'function') {
        onClick(region, spots);
      } else {
        const bounds = L.latLngBounds(
          spots
            .map(s => [parseFloat(s.lat), parseFloat(s.lng)])
            .filter(([la,ln]) => Number.isFinite(la) && Number.isFinite(ln))
        );
        if (bounds.isValid()) map.flyToBounds(bounds, { animate:true, duration:0.6, padding:[36,36], maxZoom: 8 });
        toggleLayersByZoom();
      }
    });
  });

  // 世界外接境界（情報用途。HOME は固定ビューのため直接は使用しない）
  worldBounds = flagPositions.length ? L.latLngBounds(flagPositions) : null;
}

/* =========================
 * データ描画：ポイント（クラスター）レイヤ
 * ========================= */
export function setPointMarkers(points, { onClick } = {}) {
  const esc = (v = '') =>
    String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

    const label = esc(nameOf(s)) || '—';
    m.bindTooltip(`<strong>${label}</strong>`, {
      permanent: true,
      direction: 'top',
      offset: [0, -12],
      className: 'marker-tooltip',
    }).openTooltip();

    if (typeof onClick === 'function') {
      m.on('click', () => onClick(s));
      m.on('touchend', () => onClick(s));
    }

    cluster.addLayer(m);
  });

  // 現ズームに応じてレイヤ切替
  const z = map.getZoom?.() ?? HOME_ZOOM;
  if (z >= POINT_ZOOM_THRESHOLD) {
    map.addLayer(cluster); map.removeLayer(flagLayer);
  } else {
    map.addLayer(flagLayer); map.removeLayer(cluster);
  }
}

/* ====== ズーム/移動の共通ユーティリティ ====== */
const _toLatLngs = (arr=[]) => {
  // {lat,lng} / [lat,lng] / {lat:..., lon:...} を許容
  const pick = (p) => {
    if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
    const la = Number(p?.lat ?? p?.latitude);
    const ln = Number(p?.lng ?? p?.lon ?? p?.longitude);
    return [la, ln];
  };
  return arr.map(pick).filter(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln));
};

export function fitToPoints(
  points,
  {
    animate   = true,
    padding   = [24, 24],
    duration  = 0.7,
    maxZoom   = 13,
    snapSingle= true,
    singleZoom= 13
  } = {}
){
  const ll = _toLatLngs(points);
  if (!ll.length) return;

  if (ll.length === 1 && snapSingle){
    const [la, ln] = ll[0];
    return focusSinglePoint({ lat: la, lng: ln }, singleZoom, { animate, duration });
  }

  const opts = { padding, maxZoom };
  if (animate) map.flyToBounds(ll, { ...opts, duration });
  else         map.fitBounds(ll, opts);
}

export function focusSinglePoint(
  s,
  zoom = 12.5,
  {
    animate   = true,
    duration  = 0.7,
    addMarker = false,
    openPopup = false
  } = {}
){
  const la = Number(s?.lat), ln = Number(s?.lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return;

  const latlng = L.latLng(la, ln);
  if (animate) map.flyTo(latlng, zoom, { duration });
  else         map.setView(latlng, zoom);

  if (addMarker) {
    const m = L.marker(latlng, { icon: makeGreenMarkerIcon() }).addTo(map);
    if (openPopup) m.bindPopup(String((s?.kana || s?.spot_name || '') || '')).openPopup();
    return m;
  }
}

export function getMapInstance() { return map; }

/** 任意：後から戻るハンドラを差し替えたい場合に使用 */
export function setBackToGlobeHandler(fn){
  onBackToGlobe = (typeof fn === 'function') ? fn : null;
}
