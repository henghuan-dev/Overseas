// js/list.js — Globeヒーロー右リスト対応版（7:3）＋日本語対応検索＋検索結果で一覧更新
// - 検索：region / spot_name / kana / guide（＋aliases）を横断、英語/かな/漢字OK
// - 入力のたびに右ペインの「ポイント一覧」を検索結果で即時更新
// - グラフ：右ペイン全面オーバーレイ。閉じる＝完全非表示。常に1枚だけ開く
// - 一覧クリック：周辺ポイント（同region）を表示しつつ選択ポイントに寄る & グラフ表示

import {
  initMap, setCountryFlags, setPointMarkers, focusSinglePoint, fitToPoints,
  getMapInstance, updateHomeTarget, zoomToRadius
} from './map.js';

const DATA_URL   = '../data/points.json';
const DETAIL_URL = (s) => `../index.html?region=${encodeURIComponent(s.region||'')}&point=${encodeURIComponent(s.file_name||'')}`;

const $  = (s, r=document)=> r.querySelector(s);
const $$ = (s, r=document)=> [...r.querySelectorAll(s)];
const toTitle = (t='') => t.replace(/\b\w/g, c => c.toUpperCase());
const displayName = (s) =>
  s.kana ? s.kana
         : (s.spot_name ? toTitle(s.spot_name)
                        : toTitle((s.file_name||'').replace(/-/g,' ')));

let ALL = [];
let globe = null;
let isMapMode = false;
let sizeTimer = 0;
let LAST_LIST = null;

/* ========= レスポンシブ初期視点 ========= */
const GLOBE_POV_BASE = { lat: 10, lng: 140 };
function calcAltByWidth(w){
  if (w <= 360)  return 1.55;
  if (w <= 480)  return 1.50;
  if (w <= 640)  return 1.42;
  if (w <= 768)  return 1.36;
  if (w <= 992)  return 1.32;
  if (w <= 1280) return 1.28;
  return 1.24;
}
function getGlobePOV(host){
  const w = (host?.clientWidth || window.innerWidth || 1200);
  return { ...GLOBE_POV_BASE, altitude: calcAltByWidth(w) };
}

/* ========= Leafletサイズ補正 ========= */
function refreshMapSize(delay=60){
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(()=> {
    try { getMapInstance()?.invalidateSize(); } catch(_){}
  }, delay);
}

/* ========= Region重心 ========= */
function buildRegionCentroids(points){
  const buckets = new Map();
  points.forEach(s=>{
    const region = (s.region||'').trim(); if(!region) return;
    const la = +s.lat, ln = +s.lng;
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    const cc = (s.country_code||'').toLowerCase();
    if(!buckets.has(region)) buckets.set(region, {sumLat:0, sumLng:0, n:0, flags:new Map(), name:region});
    const b = buckets.get(region);
    b.sumLat += la; b.sumLng += ln; b.n += 1;
    if(cc) b.flags.set(cc, (b.flags.get(cc)||0)+1);
  });
  return [...buckets.values()].map(b=>{
    let best='', mx=-1; b.flags.forEach((cnt,code)=>{ if(cnt>mx){mx=cnt; best=code;} });
    return { region:b.name, lat:b.sumLat/b.n, lng:b.sumLng/b.n, count:b.n, flag:best };
  }).sort((a,b)=> a.region.localeCompare(b.region,'ja'));
}

/* ========= Globe準備待ち ========= */
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
async function waitForGlobe(retries=50, interval=60){
  for(let i=0;i<retries;i++){
    if (typeof window.Globe === 'function') return window.Globe;
    await sleep(interval);
  }
  return null;
}

/* ========= Globe描画（安全版） ========= */
async function renderGlobe(){
  const host = document.getElementById('globe'); if (!host) return;

  const CreateGlobe = await waitForGlobe();
  if (!CreateGlobe){ console.warn('Globe.gl未ロード → Mapへ'); switchToMapAll(); return; }

  const webglOK = !!document.createElement('canvas').getContext('webgl');
  if (!webglOK){ console.warn('WebGL無効 → Mapへ'); switchToMapAll(); return; }

  host.innerHTML = '';
  host.style.minHeight = '400px';
  host.style.width = '100%';
  host.style.position = 'relative';
  await new Promise(r=>requestAnimationFrame(r));

  const g = CreateGlobe()(host)
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true)
    .atmosphereColor('#66d0ff')
    .atmosphereAltitude(0.12)
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png');

  if (typeof g.animateIn === 'function') g.animateIn(false);
  globe = g;

  // ライト
  try{
    const THREE = window.THREE;
    const scene = g.scene?.();
    if (THREE && scene){
      const amb = new THREE.AmbientLight(0xffffff, 0.60);
      const sun = new THREE.DirectionalLight(0xffffff, 0.80);
      sun.position.set(-1.0, 0.85, 0.6);
      scene.add(amb, sun);
    }
  }catch(_){}

  g.pointsData([]);

  // 国旗ピン
  const flagData = buildRegionCentroids(ALL).map(d=>({
    ...d, flagUrl: d.flag ? `https://flagcdn.com/32x24/${d.flag}.png` : null
  }));
  const setLat = g.htmlLat ? (fn)=>g.htmlLat(fn) : (fn)=>g.htmlLatitude(fn);
  const setLng = g.htmlLng ? (fn)=>g.htmlLng(fn) : (fn)=>g.htmlLongitude(fn);
  g.htmlElementsData(flagData);
  setLat(d => d.lat);
  setLng(d => d.lng);
  if (g.htmlAltitude) g.htmlAltitude(() => 0.022);
  g.htmlElement(d=>{
    const el = document.createElement('div');
    el.className = 'globe-flag';
    el.dataset.region = d.region;
    el.style.width='auto';
    el.innerHTML = d.flagUrl
        ? `<img loading="lazy" alt="${d.region}" src="${d.flagUrl}" width="34" height="24">
          <span class="globe-flag-label">${d.region}</span>`
        : `<span class="globe-flag-label">${d.region}</span>`;
    el.addEventListener('click', (e)=>{ e.stopPropagation(); switchToMapByRegion(d.region); });
    return el;
  });

  // 視点（レスポンシブ）
  g.pointOfView(getGlobePOV(host), 0);

  // コントロール
  try{
    const ctrl = g.controls?.();
    if (ctrl){
      ctrl.autoRotate = true;
      ctrl.autoRotateSpeed = 0.5;
      ctrl.enableDamping = true;
      ctrl.dampingFactor = 0.05;
    }
  }catch(_){}

  // リサイズ追従（未操作の間のみPOVも追従）
  let userInteracted = false;
  ['pointerdown','wheel','touchstart','keydown'].forEach(ev=>{
    host.addEventListener(ev, ()=> { userInteracted = true; }, { passive:true, once:true });
  });
  const resize = ()=>{
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, rect.width  || host.clientWidth  || 600);
    const h = Math.max(1, rect.height || host.clientHeight || 400);
    g.width(w); g.height(h);
    if (!userInteracted) g.pointOfView(getGlobePOV(host), 300);
  };
  requestAnimationFrame(resize);
  new ResizeObserver(resize).observe(host);
}

/* ========= ビュー切替 ========= */
function showGlobeOnly(){
  const g = document.getElementById('globe');
  const m = document.getElementById('map');
  g?.classList.remove('is-hidden');
  m?.classList.add('is-hidden');
  document.getElementById('left-switch')?.classList.remove('map-mode');
  isMapMode = false;
}

function showMapOnly(){
  const g = document.getElementById('globe');
  const m = document.getElementById('map');
  g?.classList.add('is-hidden');
  m?.classList.remove('is-hidden');
  document.getElementById('left-switch')?.classList.add('map-mode');
  isMapMode = true;
  refreshMapSize(120);
}

function switchToMapAll(){
  showMapOnly();
  setCountryFlags(ALL, {
    onClick: (_region, spots) => {
      setPointMarkers(spots, { onClick: (s)=> openGraphPanel(s) });
      renderResults(spots); refreshMapSize();
    }
  });
  const lab = $('#map-region-label'); if (lab) lab.textContent = '全体';
  renderResults(ALL.slice(0, 80));
}
function switchToMapByRegion(regionName){
  const spots = ALL.filter(s => (s.region||'').trim() === regionName);
  closeGraphPanel();
  if (!spots.length){ switchToMapAll(); return; }
  const cen = (()=>{ let la=0,ln=0,n=0;
    spots.forEach(s=>{ const a=+s.lat,b=+s.lng;
      if(Number.isFinite(a)&&Number.isFinite(b)){ la+=a; ln+=b; n++; }
    });
    return n ? L.latLng(la/n, ln/n) : null;
  })();
  if (cen) zoomToRadius(cen, 100, { animate:false });
  showMapOnly();
  const lab = $('#map-region-label'); if (lab) lab.textContent = regionName;
  setPointMarkers(spots, { onClick: (s)=> openGraphPanel(s) });
  renderResults(spots);
  refreshMapSize(80);
}
function switchToGlobe(){
  closeGraphPanel();
  showGlobeOnly();
  requestAnimationFrame(()=>{
    try{
      const host = document.getElementById('globe');
      const rect = host.getBoundingClientRect();
      globe.width(rect.width || host.clientWidth || 600);
      globe.height(rect.height || host.clientHeight || 400);
      globe.pointOfView(getGlobePOV(host), 600);
    }catch(_){}
  });
}

/* ===== グラフ・パネル ===== */
function ensureGraphPanel(){
  // パネルは右ペインの #results の“上に重なる”
  const host = document.getElementById('results');
  if (!host) return null;

  let panel = host.querySelector('#graph-panel');
  if (!panel){
    panel = document.createElement('div');
    panel.id = 'graph-panel';
    panel.setAttribute('aria-hidden','true');
    panel.hidden = true; // 初期は完全非表示
    panel.innerHTML = `
      <header class="gp-head">
        <div id="graph-title" class="gp-title">Loading…</div>
        <div class="gp-tabs" role="tablist" aria-label="Graph and Guide">
          <button class="gp-tab is-active" data-tab="graph" role="tab" aria-selected="true">Graph</button>
          <button class="gp-tab"          data-tab="guide" role="tab" aria-selected="false">Guide</button>
        </div>
        <button type="button" id="graph-close" class="gp-close" aria-label="閉じる">×</button>
      </header>
      <div class="gp-body">
        <div id="graph-view" class="gp-view is-active" role="tabpanel">
          <iframe id="graph-frame" title="ポイントのグラフ" loading="lazy"></iframe>
        </div>
        <div id="guide-view" class="gp-view" role="tabpanel" aria-hidden="true">
          <div id="guide-body">No guide</div>
        </div>
      </div>
    `;
    host.prepend(panel);

    // タブ切替（閉じるボタンは openGraphPanel 内で毎回バインド）
    panel.addEventListener('click', (e)=>{
      const btn = e.target.closest('.gp-tab'); if(!btn) return;
      const tab = btn.dataset.tab; if(!tab) return;
      const tabs = panel.querySelectorAll('.gp-tab');
      tabs.forEach(b=>{
        const active = b===btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      const graphV = panel.querySelector('#graph-view');
      const guideV = panel.querySelector('#guide-view');
      if (tab === 'guide'){
        graphV?.classList.remove('is-active'); graphV?.setAttribute('aria-hidden','true');
        guideV?.classList.add('is-active');    guideV?.setAttribute('aria-hidden','false');
      }else{
        guideV?.classList.remove('is-active'); guideV?.setAttribute('aria-hidden','true');
        graphV?.classList.add('is-active');    graphV?.setAttribute('aria-hidden','false');
      }
    });
  }
  return panel;
}

/* ==========================
   Graph Panel: helpers
   ========================== */
/** すでに開いている Graph パネルをすべて閉じる（except は除外） */
function closeAllGraphPanels(exceptEl){
  const list = document.querySelectorAll('#graph-panel.is-open, .graph-panel.is-open');
  list.forEach(el => { if (!exceptEl || el !== exceptEl) closeGraphPanel(el); });
}

/* ==========================
   Graph Panel: Open / Close
   ========================== */
function openGraphPanel(spot){
  const TAG = '[GraphPanel:open]';

  // 常に先に全部閉じる（1枚だけ開くポリシー）
  closeAllGraphPanels();

  const panel = ensureGraphPanel();
  if (!panel) {
    console.error(`${TAG} ensureGraphPanel() が null/undefined を返しました。`);
    return;
  }

  // 右ペイン全面オーバーレイのアンカーへ配置
  const anchor =
    document.querySelector('.right-list .pane') ||
    document.getElementById('results')?.parentElement ||
    document.getElementById('results')?.closest('.pane');
  if (anchor && panel.parentElement !== anchor) {
    try { anchor.appendChild(panel); }
    catch (err) { console.error(`${TAG} panel の移動に失敗しました。`, err); }
  }

  // タイトル（kana → spot_name → file_name）
  try {
    const toLabel = (s) =>
      (s?.kana && String(s.kana).trim()) ||
      (s?.spot_name && String(s.spot_name).trim()) ||
      String(s?.file_name || '').replace(/-/g, ' ').trim();
    const titleEl = panel.querySelector('#graph-title');
    if (titleEl) titleEl.textContent = toLabel(spot);
  } catch (err) {
    console.warn(`${TAG} タイトル設定に失敗しました。`, err);
  }

  // iframe 埋め込み：chart_iframe.html
  try {
    const url = `../chart_iframe.html?region=${encodeURIComponent(spot?.region || '')}&point=${encodeURIComponent(spot?.file_name || '')}`;
    const frame = panel.querySelector('#graph-frame');
    if (frame) {
      if (frame.src !== url) frame.src = url;
    } else {
      console.warn(`${TAG} #graph-frame が見つかりません。`);
    }
  } catch (err) {
    console.error(`${TAG} iframe の設定でエラー。`, err);
  }

  // Guide テキスト（points.json の guide）
  try {
    const guideBox = panel.querySelector('#guide-body');
    if (guideBox) {
      const guide = String(spot?.guide || '').trim();
      guideBox.textContent = guide || '（ガイド情報はありません）';
    }
  } catch (err) {
    console.warn(`${TAG} ガイド本文の設定に失敗しました。`, err);
  }

  // タブ初期化：Graph を初期表示
  try {
    const tabGraph = panel.querySelector('.gp-tab[data-tab="graph"]');
    const tabGuide = panel.querySelector('.gp-tab[data-tab="guide"]');
    tabGraph?.classList.add('is-active');   tabGraph?.setAttribute('aria-selected', 'true');
    tabGuide?.classList.remove('is-active'); tabGuide?.setAttribute('aria-selected', 'false');

    const graphView = panel.querySelector('#graph-view');
    const guideView = panel.querySelector('#guide-view');
    graphView?.classList.add('is-active');   graphView?.setAttribute('aria-hidden', 'false');
    guideView?.classList.remove('is-active'); guideView?.setAttribute('aria-hidden', 'true');
  } catch (err) {
    console.warn(`${TAG} タブ初期化に失敗しました。`, err);
  }

  // 閉じるボタン：毎回確実にバインド（今の panel を引数で渡す）
  try {
    const closeBtn = panel.querySelector('.gp-close');
    if (closeBtn) {
      closeBtn.onclick = (e) => { e.preventDefault(); closeGraphPanel(panel); };
    } else {
      console.warn(`${TAG} .gp-close が見つかりません。`);
    }
  } catch (err) {
    console.error(`${TAG} 閉じるボタンのバインドでエラー。`, err);
  }

  // 表示（完全に非表示→表示 方式）
  try {
    panel.hidden = false;
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
  } catch (err) {
    console.error(`${TAG} パネルの表示切替に失敗しました。`, err);
  }

  // 下地（一覧）のロック
  if (anchor) anchor.classList.add('panel-open');

  // 現行のパネル参照をグローバルにも保持（保険）
  window.__graphPanel = panel;

  // Esc で閉じる（毎回1回限り登録）
  const onEsc = (e) => { if (e.key === 'Escape') closeGraphPanel(panel); };
  document.addEventListener('keydown', onEsc, { once: true });
}

function closeGraphPanel(panelEl){
  const TAG = '[GraphPanel:close]';

  try {
    // 参照の取り方を強化：引数 → グローバル → DOM検索
    const panel =
      panelEl ||
      window.__graphPanel ||
      document.getElementById('graph-panel') ||
      document.querySelector('#graph-panel, .graph-panel');

    if (!panel) {
      console.error(`${TAG} パネル要素を解決できませんでした（引数/グローバル/DOM全てで未検出）。`);
      return;
    }

    // 1) 完全に非表示へ
    try {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      panel.hidden = true;
      console.debug(`${TAG} パネルを非表示にしました.`);
    } catch (err) {
      console.error(`${TAG} 非表示処理でエラー。`, err);
    }

    // 2) 下地（右ペイン）のロック解除
    try {
      const anchor =
        panel.closest('.right-list .pane') ||
        document.querySelector('.right-list .pane') ||
        document.getElementById('results')?.parentElement;

      if (anchor) {
        anchor.classList.remove('panel-open');
      } else {
        console.warn(`${TAG} アンカー(.right-list .pane)が見つからず、panel-open を解除できませんでした。`);
      }
    } catch (err) {
      console.error(`${TAG} 下地ロック解除でエラー。`, err);
    }

    // 3) iframe を停止・リセット
    try {
      const frame = panel.querySelector('#graph-frame');
      if (frame) {
        try { frame.contentWindow?.postMessage?.({ type: 'pause' }, '*'); }
        catch (postErr) { console.warn(`${TAG} iframe postMessage(pause) に失敗。`, postErr); }
        frame.src = 'about:blank';
      } else {
        console.warn(`${TAG} #graph-frame が見つからず、src リセットをスキップ。`);
      }
    } catch (err) {
      console.error(`${TAG} iframe リセットでエラー。`, err);
    }

    // 4) 参照クリア（保険）
    if (window.__graphPanel === panel) {
      window.__graphPanel = null;
    }

  } catch (err) {
    console.error(`${TAG} 想定外のエラー。`, err);
  }
}

/* ========= リスト描画先の自動選択 ========= */
function getResultsHost(){
  if (!isMapMode){
    return document.getElementById('results-hero') || document.getElementById('results');
  }
  return document.getElementById('results');
}

/* ========= 右リスト（共通） ========= */
function renderResults(list){
  const wrap = getResultsHost(); if (!wrap) return;
  LAST_LIST = list;

  wrap.innerHTML = '';
  if (!list || !list.length){
    wrap.innerHTML = '<div class="result-item">該当するポイントがありません</div>';
    if (isMapMode) refreshMapSize();
    return;
  }
  list.slice(0, 120).forEach(s=>{
    const row = document.createElement('div');
    row.className = 'result-item';
    row.tabIndex = 0;
    const flag = document.createElement('span');
    flag.className = `flag-icon flag-icon-${(s.country_code||'').toLowerCase()} flag-icon-squared`;
    row.appendChild(flag);
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = displayName(s);
    row.appendChild(name);

    // クリックしたときだけマップを動かす & グラフ表示
    row.addEventListener('click', ()=>{
      if (isMapMode){
        const region = (s.region||'').trim();
        const regionSpots = ALL.filter(x => (x.region||'').trim() === region);
        setPointMarkers(regionSpots, { onClick: (x)=> openGraphPanel(x) });
        focusSinglePoint(s, 10);
        renderResults(regionSpots);
        refreshMapSize();
      }
      openGraphPanel(s);
    });

    // キーボード操作（Enter / Space でクリック扱い）
    row.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        row.click();
      }
    });
    wrap.appendChild(row);
  });

  if (isMapMode) refreshMapSize();
}

/* ========= 戻るボタン ========= */
function wireBackButton(){
  const headerBtn = $('#back-to-globe-btn');
  if (headerBtn){ headerBtn.addEventListener('click', switchToGlobe); return; }
  const host = $('#map'); if (!host) return;
  if (host.querySelector('[data-globe-back]')) return;
  const wrap = document.createElement('div');
  wrap.className = 'map-controls';
  const grp = document.createElement('div');
  grp.className = 'ctrl-group';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'ctrl-btn';
  btn.setAttribute('data-globe-back','1'); btn.textContent = '🌍 Globeに戻る';
  grp.appendChild(btn); wrap.appendChild(grp); host.appendChild(wrap);
  btn.addEventListener('click', switchToGlobe);
}

/* ========= 検索（日本語対応：英語・かな・漢字） ========= */
/* 仕様：
   - region / spot_name / kana / guide（＋aliases）を索引化
   - 全半角統一（NFKC）→ 小文字 → カタカナ→ひらがな → 記号/空白除去 で照合
   - 複数語は AND（全語含有）でマッチ
   - スコア：完全一致 > 前方一致 > 全語含有
*/

// カタカナ → ひらがな
function toHiragana(str=''){
  return String(str).replace(/[\u30A1-\u30FA\u30FD-\u30FF]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}
// 正規化：NFKC → lower → カナ→ひらがな
function normalizeJPBase(str=''){
  return toHiragana(String(str).normalize('NFKC').toLowerCase());
}
// 索引用に英数+ひらがな+漢字のみ残す
function compactForIndex(str=''){
  return String(str).replace(/[^a-z0-9\u3040-\u309F\u4E00-\u9FFF]+/g, '');
}
// hay（索引用文字列）を作成
function makeHay(...fields){
  return compactForIndex(normalizeJPBase(fields.filter(Boolean).join(' ')));
}
// クエリ語分割
function queryTerms(q){
  const base = normalizeJPBase(q||'').trim();
  return base.split(/\s+/).map(compactForIndex).filter(Boolean);
}

function buildSearchIndex(points){
  // 地域の集計
  const regionMap = new Map();
  points.forEach(s=>{
    const region = (s.region||'').trim(); if(!region) return;
    const cc = (s.country_code||'').toLowerCase();
    if(!regionMap.has(region)) regionMap.set(region, {name:region, flags:new Map(), count:0});
    const r = regionMap.get(region);
    r.count++; if (cc) r.flags.set(cc,(r.flags.get(cc)||0)+1);
  });

  const regions = [...regionMap.values()].map(r=>{
    let best='', mx=-1; r.flags.forEach((n,code)=>{ if(n>mx){mx=n; best=code;} });
    return {
      type: 'region',
      key:  r.name,
      name: r.name,
      flag: best,
      count: r.count,
      hay:  makeHay(r.name) // ★ 地域名で検索
    };
  });

  const spots = points.map(s=>{
    const name = s.spot_name || (s.file_name||'').replace(/-/g,' ');
    return {
      type:   'spot',
      key:    s.file_name || '',
      name,
      region: (s.region||'').trim(),
      flag:   (s.country_code||'').toLowerCase(),
      ref:    s,
      hay:    makeHay(
                s.region,
                s.spot_name,
                s.kana,
                s.guide,
                Array.isArray(s.aliases) ? s.aliases.join(' ') : ''
              )
    };
  });

  return { regions, spots };
}

function searchEverything(idx, q, limit=200){
  const terms = queryTerms(q);
  if (!terms.length) return [];

  const joined = terms.join('');
  const kwRaw  = String(q||'').trim().toLowerCase();

  // スコア
  const scoreHay = (hay='')=>{
    if (!hay) return -1;
    if (hay === joined)                     return 100; // 完全一致
    if (hay.startsWith(joined))             return 85;  // 前方一致
    if (terms.every(t => hay.includes(t)))  return 70;  // 全語含有
    return -1;
  };

  // 地域
  const rHits = idx.regions.map(r=>{
    const sc = scoreHay(r.hay);
    return sc>0 ? {...r, score:sc} : null;
  }).filter(Boolean);

  // ポイント
  const pHits = idx.spots.map(p=>{
    const sc = Math.max(
      scoreHay(p.hay),
      (p.flag && p.flag === kwRaw ? 75 : -1) // 国コード（例: jp, us）
    );
    return sc>0 ? {...p, score:sc} : null;
  }).filter(Boolean);

  return [...rHits, ...pHits]
    .sort((a,b)=> b.score - a.score || (b.count||0)-(a.count||0))
    .slice(0, limit);
}

// 検索ヒットを「一覧で表示するスポット配列」に展開（重複排除）
function hitsToSpotList(hits, limit=200){
  const seen = new Set();
  const out = [];

  for (const h of hits){
    if (h.type === 'spot' && h.ref){
      const key = h.ref.file_name || h.ref.spot_name || `${h.ref.lat},${h.ref.lng}`;
      if (!seen.has(key)){ seen.add(key); out.push(h.ref); }
    } else if (h.type === 'region' && h.name){
      const reg = h.name;
      for (const s of ALL){
        if ((s.region||'').trim() === reg){
          const key = s.file_name || s.spot_name || `${s.lat},${s.lng}`;
          if (!seen.has(key)){ seen.add(key); out.push(s); }
        }
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

function initHeaderSearch(idx){
  const form  = $('#global-search');
  const input = $('#global-q');
  const box   = $('#search-suggest');
  if (!form || !input || !box) return;

  let active = -1, items = [];

  const closeSuggest = ()=>{ box.hidden = true; box.innerHTML = ''; active = -1; items = []; };
  const openSuggest  = ()=>{ box.hidden = false; };

  const renderSuggest = (hits)=>{
    items = hits; box.innerHTML = '';
    if (!hits.length){ closeSuggest(); return; }
    openSuggest();
    hits.slice(0, 12).forEach((h,i)=>{
      const row = document.createElement('div');
      row.className = 'sug-item'; row.setAttribute('role','option'); row.dataset.index = String(i);
      const icon = document.createElement('div');
      icon.className = 'sug-flag';
      icon.innerHTML = h.flag ? `<span class="flag-icon flag-icon-${h.flag} flag-icon-squared"></span>` : '🌍';
      const label = document.createElement('div'); label.className = 'sug-label'; label.textContent = h.name;
      const meta  = document.createElement('div'); meta.className = 'sug-type'; meta.textContent = h.type==='region' ? '国' : 'ポイント';
      row.append(icon, label, meta);
      row.addEventListener('click', ()=> pick(i));
      box.appendChild(row);
    });
  };

  // クリック時の挙動（従来どおり）
  const pick = (i)=>{
    const h = items[i]; if (!h) return;
    if (h.type === 'region'){
      switchToMapByRegion(h.name);
      const lab = $('#map-region-label'); if (lab) lab.textContent = h.name;
      renderResults(ALL.filter(s => (s.region||'').trim() === h.name));
    }else{
      const spot = h.ref;
      showMapOnly();
      const regionSpots = ALL.filter(s => (s.region||'').trim() === (spot.region||'').trim());
      setPointMarkers(regionSpots, { onClick: (s)=> openGraphPanel(s) });
      fitToPoints([spot], { animate: true });
      focusSinglePoint(spot, 10);
      renderResults(regionSpots);
      refreshMapSize();
      openGraphPanel(spot);
    }
    closeSuggest();
  };

  // 入力のたびに「サジェスト」と「右リスト」を同期更新
  const doSearch = (q)=>{
    const hits = searchEverything(idx, q, 200);
    renderSuggest(hits);
    const list = q.trim()
      ? hitsToSpotList(hits, 200)           // 検索クエリあり → ヒットを一覧化
      : ALL.slice(0, 80);                   // 空欄 → 既定の一覧に戻す
    renderResults(list);
  };

  // 入力（デバウンス）
  let t; input.addEventListener('input', ()=>{
    clearTimeout(t);
    t = setTimeout(()=> doSearch(input.value), 100);
  });

  // キー操作（IME中は送信しない）
  input.addEventListener('keydown', (e)=>{
    if (e.isComposing) return;
    if (!box.hidden){
      if (e.key === 'ArrowDown'){ e.preventDefault(); active = Math.min(items.length-1, active+1); updateActive(); return; }
      if (e.key === 'ArrowUp'){   e.preventDefault(); active = Math.max(0, active-1); updateActive(); return; }
    }
    if (e.key === 'Enter'){
      if (active >= 0 && !box.hidden){ e.preventDefault(); pick(active); }
      else {
        // Enter 単独：一覧は既に検索結果に置き換わっているので何もしない
        e.preventDefault();
        closeSuggest();
      }
    }else if (e.key === 'Escape'){ closeSuggest(); }
  });
  function updateActive(){ [...box.children].forEach((el,i)=> el.classList.toggle('is-active', i===active)); }

  // ボタンクリック（既に一覧は更新済みなので、サジェストだけ閉じる）
  form.addEventListener('submit', (e)=>{ if (e.isComposing) return; e.preventDefault(); closeSuggest(); });
  const btn = form.querySelector('.head-btn');
  if (btn){ btn.addEventListener('click', (e)=>{ e.preventDefault(); closeSuggest(); }); }

  document.addEventListener('click', (e)=>{ if (!form.contains(e.target)) closeSuggest(); }, true);
}

/* ========= 起動 ========= */
document.addEventListener('DOMContentLoaded', async ()=>{
  const openMapBtn = $('#open-map-btn'); if (openMapBtn) openMapBtn.style.display = 'none';
  initMap('map', { center:[20,0], zoom:3, dark:false });   // 先にMap準備
  wireBackButton();
  showGlobeOnly();                                         // 初期はGlobe（右に#results-hero）

  try{
    const res = await fetch(DATA_URL, { cache:'no-store' });
    ALL = await res.json();

    // Map用の国旗レイヤ
    setCountryFlags(ALL, {
      onClick: (_region, spots) => {
        setPointMarkers(spots, { onClick: (s)=> openGraphPanel(s) });
        renderResults(spots); refreshMapSize();
      }
    });

    // 検索インデックス構築（日本語対応）
    const idx = buildSearchIndex(ALL);
    initHeaderSearch(idx);

    // Globe描画
    await renderGlobe();

    // 初期表示：Globe右リストに全体の一部を表示
    renderResults(ALL.slice(0, 80));

  }catch(e){
    console.error('ポイントデータ読み込み失敗:', e);
    switchToMapAll();
  }

  window.addEventListener('resize', ()=> isMapMode && refreshMapSize(60));
});
