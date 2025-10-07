// js/map.js
// Carto Voyager / Carto Dark を使った“モダンUI”版（緑色マーカー対応）
// - ズーム＋/−、ホーム、ダーク切替（右上に縦配置）
// - 「Globeに戻る」ボタン（data-ui="back-to-globe"）を自動検出して確実に動作
// - 国旗⇄ポイント切替はズーム閾値で自動
// - layers.js の makeGreenMarkerIcon()/makeFlagIcon() を使用

import { createClusterOptions, makeFlagIcon, makeGreenMarkerIcon } from './layers.js?v=0.1';

let map, cluster, flagLayer;
let worldBounds = null;   // すべての国旗重心の外接境界（setCountryFlags完了後に確定）
let homeBounds  = null;   // 直近の国や領域を示す境界（updateHomeTargetで更新）

const DEFAULT_CENTER = [28, 28];
const DEFAULT_ZOOM   = 1.8;
const CUSTOM_ZOOM_STEPS = Object.freeze([2, 3.5, 5, 6.5, 8, 9.5, 11, 12.5, 14, 16, 18]);
const ZOOM_EPSILON = 1e-3;

let basemapLight, basemapDark, currentTheme = 'light';
let scaleControl = null;
const POINT_ZOOM_THRESHOLD = 5;

// 「Globeに戻る」時にページ側へ教えるためのコールバック
let onBackToGlobe = null;

/** =========================
 * マップ初期化
 * ========================= */
export function initMap(domId = 'map', { center = [20, 0], zoom = 8, dark = false, onBackToGlobe: cb } = {}) {
  const minZoom = Math.min(DEFAULT_ZOOM, zoom, ...CUSTOM_ZOOM_STEPS);
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

  // 初期は国旗のみ
  map.removeLayer(cluster);
  map.addLayer(flagLayer);

  // 縮尺（Leaflet標準）
  scaleControl = L.control.scale({ imperial: false });
  scaleControl.addTo(map);

  // ズームで国旗⇄ポイント切替
  map.on('zoomend', toggleLayersByZoom);

  // 自前UI（右上）を注入
  injectModernControls(domId);

  // 「Globeに戻る」ボタンを確実にバインド
  bindBackToGlobeButton(domId);

  return { map, cluster, flagLayer };
}

/** =========================
 * Globeに戻る（イベント本体）
 * ========================= */
function handleBackToGlobe() {
  try {
    // 1) ページ側に通知（Globe表示へ切替してもらう）
    if (typeof onBackToGlobe === 'function') onBackToGlobe();
  } catch(_) {}

  try {
    // 2) マップ側は国旗レイヤに戻し、視点をワールド or ホーム境界へ
    if (!map) return;

    // レイヤ状態を国旗モードへ復帰
    if (!map.hasLayer(flagLayer)) map.addLayer(flagLayer);
    if (map.hasLayer(cluster))    map.removeLayer(cluster);

    // 先にcenterだけ寄せ、次にズーム確定（慣性で止まりづらくする）
    const WORLD_CENTER = L.latLng(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
    const WORLD_ZOOM   = DEFAULT_ZOOM;

    // 直近ホーム or ワールド境界がある場合は境界優先
    const targetBounds = homeBounds || worldBounds;

    if (targetBounds) {
      map.flyToBounds(targetBounds, { animate:true, duration:0.6, padding:[32,32] });
    } else {
      // 境界が未設定なら center→zoom の2段階
      map.flyTo(WORLD_CENTER, map.getZoom(), { duration: .35, easeLinearity: .8 });
      setTimeout(() => {
        map.flyTo(WORLD_CENTER, WORLD_ZOOM, { duration: .45, easeLinearity: .9 });
      }, 180);
    }
  } catch(_) {}
}

/** 「Globeに戻る」ボタンのセレクタを一元化して確実に拾う */
function bindBackToGlobeButton(hostId) {
  const host = document.getElementById(hostId) || document;
  const q = () => host.querySelector('[data-ui="back-to-globe"]');

  const attach = () => {
    const btn = q();
    if (!btn) return;

    // 二重登録防止
    if (btn._backBound) return;
    btn._backBound = true;

    // クリック/タッチ双方に対応
    btn.addEventListener('click', handleBackToGlobe);
    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleBackToGlobe();
    }, { passive:false });
  };

  attach();

  // DOM動的変化にも追従
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

/** ========= ズーム段階ユーティリティ ========= */
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
  if (!Number.isFinite(target)) return;
  // setZoom だけでなく flyTo も使い分けて途中停止を回避
  const c = map.getCenter();
  map.flyTo(c, target, { duration: .35, easeLinearity: .9 });
}

/** ───── 自前UI（右上・縦配置。Globeボタンの下に追従） ───── */
function injectModernControls(hostId){
  const host = document.getElementById(hostId);
  if (!host) return;

  // 「Globeに戻る」ボタンからの間隔（px）
  const MAP_TOOLS_MARGIN_BELOW_GLOBE =
    (window && window.MAP_TOOLS_MARGIN_BELOW_GLOBE) ?? 80;

  // ラッパ
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

  // 見た目/位置/層
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

  // 「Globeに戻る」（list.js が作る .map-controls）を基準に、その“さらに下”へ配置
  const positionTools = ()=>{
    try{
      const backWrap = host.querySelector('.map-controls'); // ← 戻るボタン側
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

  // クリック動作
  wrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('.ctrl-btn'); if (!btn) return;
    const act = btn.dataset.act;
    switch(act){
      case 'zoom-in':  stepZoom(1); break;
      case 'zoom-out': stepZoom(-1); break;
      case 'home': {
        // 国旗表示へ復帰
        if (!map.hasLayer(flagLayer)) map.addLayer(flagLayer);
        if (map.hasLayer(cluster))    map.removeLayer(cluster);

        if (homeBounds) {
          map.flyToBounds(homeBounds, { animate:true, duration:0.6, padding:[32,32] });
        } else if (worldBounds) {
          map.flyToBounds(worldBounds, { animate:true, duration:0.6, padding:[32,32] });
        } else {
          map.flyTo(L.latLng(DEFAULT_CENTER[0], DEFAULT_CENTER[1]), DEFAULT_ZOOM, { animate:true, duration:0.6 });
        }
        break;
      }
      case 'theme': toggleTheme(); break;
    }
  });
}

/** =========================
 * 直近選択した国のポイント配列から「ホーム」境界を設定
 * ========================= */
export function updateHomeTarget(points=[]){
  const coords = points
    .map(s => [parseFloat(s.lat), parseFloat(s.lng)])
    .filter(([la,ln]) => Number.isFinite(la) && Number.isFinite(ln));
  homeBounds = coords.length ? L.latLngBounds(coords) : null;
}

/** テーマ切替 */
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

/** 任意の中心半径へズーム（領域フォーカス） */
export function zoomToRadius(latlng, radiusKm = 60, { animate = true } = {}) {
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

/** =========================
 * データ描画系：国旗レイヤ
 * ========================= */
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
      updateHomeTarget(spots);
      zoomToRadius(L.latLng(lat, lng), 100);
      toggleLayersByZoom();
      onClick?.(region, spots);
    });
  });

  // 世界外接境界を更新（Homeが未設定時のフォールバックに使う）
  worldBounds = flagPositions.length ? L.latLngBounds(flagPositions) : null;
}

/** =========================
 * データ描画系：ポイント（クラスター）レイヤ
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
  const z = map.getZoom();
  if (z >= POINT_ZOOM_THRESHOLD) {
    map.addLayer(cluster); map.removeLayer(flagLayer);
  } else {
    map.addLayer(flagLayer); map.removeLayer(cluster);
  }
}

/** ====== ズーム/移動の共通ユーティリティ ====== */
const _toLatLngs = (points=[]) =>
  points.map(s => [Number(s?.lat), Number(s?.lng)])
        .filter(([la, ln]) => Number.isFinite(la) && Number.isFinite(ln));

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

/* ===== ヘルパ ===== */
function toTitle(t=''){ return t.replace(/\b\w/g, c => c.toUpperCase()); }
