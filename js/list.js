// js/list.js — Graph/Guideを hero-2col と .pane.surfline-pane の間に常設配置
// - Globe/country-bar クリック：マップに切替えず、右のポイント一覧だけ更新（SPは一覧へスクロール）
// - ラベル：デフォルト「All Points」。国クリック時は国旗＋国名に変更
// - 結果一覧：国旗なし（ポイント名のみ）
// - Graph/Guide パネルはポイント一覧から分離し、#hero-2col と .pane.surfline-pane の「間」に挿入
// - ポイントクリックで Graph/Guide の中身だけ更新（一覧はそのまま）

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

/* ===== ユーティリティ ===== */
function refreshMapSize(delay=60){
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(()=> { try { getMapInstance()?.invalidateSize(); } catch(_){} }, delay);
}
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
function isSP(){ return window.innerWidth <= 768; }
function scrollToListIfSP(){
  if (!isSP()) return;
  const target = $('#results') || $('#results-hero');
  if (target) target.scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ===== リスト見出し（ラベル） ===== */
function ensureListLabel(){
  let label = $('#list-label');
  if (label) return label;

  const results = $('#results') || $('#results-hero');
  if (!results) return null;

  label = document.createElement('div');
  label.id = 'list-label';
  label.className = 'list-label';
  label.innerHTML = `<span class="label-text">All Points</span>`;

  try { results.parentElement.insertBefore(label, results); }
  catch { results.parentElement?.prepend(label); }

  return label;
}
function setListLabel(regionText='', flagCode=''){
  const label = ensureListLabel(); if (!label) return;
  if (!regionText){
    label.innerHTML = `<span class="label-text">All Points</span>`;
    return;
  }
  const flag = flagCode ? `<span class="flag-icon flag-icon-${flagCode} flag-icon-squared" style="margin-right:8px"></span>` : '';
  label.innerHTML = `${flag}<span class="label-text">${regionText}</span>`;
}

/* ========= レスポンシブ初期視点（Globe） ========= */
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

/* ========= Region重心（Globe用） ========= */
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
async function waitForGlobe(retries=50, interval=60){
  for(let i=0;i<retries;i++){
    if (typeof window.Globe === 'function') return window.Globe;
    await sleep(interval);
  }
  return null;
}

/* ========= Globe描画（★国クリックでリストのみ更新） ========= */
async function renderGlobe(){
  const host = document.getElementById('globe'); if (!host) return;

  const CreateGlobe = await waitForGlobe();
  if (!CreateGlobe){ console.warn('Globe.gl未ロード'); return; }

  const webglOK = !!document.createElement('canvas').getContext('webgl');
  if (!webglOK){ console.warn('WebGL無効'); return; }

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

  // ライト（任意）
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

  // 国旗ピン（クリック＝リスト更新＋SPは一覧へスクロール）
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
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      selectRegionForList(d.region, d.flag);
    });
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

  // リサイズ追従
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
  $('#globe')?.classList.remove('is-hidden');
  $('#map')?.classList.add('is-hidden');
  $('#left-switch')?.classList.remove('map-mode');
  isMapMode = false;
}
function showMapOnly(){
  $('#globe')?.classList.add('is-hidden');
  $('#map')?.classList.remove('is-hidden');
  $('#left-switch')?.classList.add('map-mode');
  isMapMode = true;
  refreshMapSize(120);
}

/* ===== Graph/Guide パネル（常設：hero-2col と .pane.surfline-pane の間） ===== */
function insertAfter(refNode, newNode){
  if (!refNode || !refNode.parentNode) return false;
  if (refNode.nextSibling) refNode.parentNode.insertBefore(newNode, refNode.nextSibling);
  else refNode.parentNode.appendChild(newNode);
  return true;
}
function ensureGraphPanel(){
  // 既存取得 or 新規作成
  let panel = document.getElementById('graph-panel');
  if (!panel){
    panel = document.createElement('section');
    panel.id = 'graph-panel';
    panel.className = 'graph-panel'; // オーバーレイではなく通常フローのブロック

    panel.innerHTML = `
      <header class="gp-head">
        <div id="graph-title" class="gp-title">Select a point</div>
        <div class="gp-tabs" role="tablist" aria-label="Graph and Guide">
          <button class="gp-tab is-active" data-tab="graph" role="tab" aria-selected="true">Graph</button>
          <button class="gp-tab"          data-tab="guide" role="tab" aria-selected="false">Guide</button>
        </div>
      </header>
      <div class="gp-body">
        <div id="graph-view" class="gp-view is-active" role="tabpanel">
          <iframe id="graph-frame" title="ポイントのグラフ" loading="lazy"></iframe>
        </div>
        <div id="guide-view" class="gp-view" role="tabpanel" aria-hidden="true">
          <div id="guide-body">（ポイントを選ぶとガイドが表示されます）</div>
        </div>
      </div>
    `;

    // ===== 挿入位置：
    //   1) .pane.surfline-pane の直前
    //   2) なければ #hero-2col の直後
    //   3) どちらもなければ <main> 末尾
    const surfPane = document.querySelector('.pane.surfline-pane');
    const hero = document.getElementById('hero-2col') || document.querySelector('.hero-2col');
    if (surfPane && surfPane.parentElement){
      surfPane.parentElement.insertBefore(panel, surfPane);
    }else if (hero){
      insertAfter(hero, panel);
    }else{
      (document.querySelector('main') || document.body).appendChild(panel);
    }

    // タブ切替（UIだけ。開閉はしない＝常設）
    panel.addEventListener('click', (e)=>{
      const btn = e.target.closest('.gp-tab'); if (!btn) return;
      const tab = btn.dataset.tab;
      panel.querySelectorAll('.gp-tab').forEach(b=>{
        const act = b===btn; b.classList.toggle('is-active', act); b.setAttribute('aria-selected', act?'true':'false');
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
function openGraphPanel(spot){
  const panel = ensureGraphPanel(); if (!panel) return;

  // タイトル（kana → spot_name → file_name）
  const toLabel = (s) =>
    (s?.kana && String(s.kana).trim()) ||
    (s?.spot_name && String(s.spot_name).trim()) ||
    String(s?.file_name || '').replace(/-/g, ' ').trim();
  const titleEl = panel.querySelector('#graph-title');
  if (titleEl) titleEl.textContent = toLabel(spot);

  // iframe
  const url = `../chart_iframe.html?region=${encodeURIComponent(spot?.region || '')}&point=${encodeURIComponent(spot?.file_name || '')}`;
  const frame = panel.querySelector('#graph-frame');
  if (frame && frame.src !== url) frame.src = url;

  // Guide
  const guideBox = panel.querySelector('#guide-body');
  if (guideBox) guideBox.textContent = (String(spot?.guide || '').trim() || '（ガイド情報はありません）');
}

/* ========= リスト描画先の自動選択 ========= */
function getResultsHost(){
  if (!isMapMode){
    return document.getElementById('results-hero') || document.getElementById('results');
  }
  return document.getElementById('results');
}

/* ========= 右リスト（★国旗を表示しない） ========= */
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

    // 国旗は表示しない → ポイント名のみ
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = displayName(s);
    row.appendChild(name);

    // クリック：一覧はそのまま、Graph/Guide の中身だけ更新
    row.addEventListener('click', ()=> { openGraphPanel(s); });

    // キーボード操作
    row.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); row.click(); }
    });

    wrap.appendChild(row);
  });

  if (isMapMode) refreshMapSize();
}

/* ========= 戻るボタン ========= */
function wireBackButton(){
  const headerBtn = $('#back-to-globe-btn');
  if (headerBtn){ headerBtn.addEventListener('click', showGlobeOnly); return; }
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
  btn.addEventListener('click', showGlobeOnly);
}

/* ========= 検索（日本語対応） ========= */
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
      hay:  makeHay(r.name)
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

  const scoreHay = (hay='')=>{
    if (!hay) return -1;
    if (hay === joined)                     return 100; // 完全一致
    if (hay.startsWith(joined))             return 85;  // 前方一致
    if (terms.every(t => hay.includes(t)))  return 70;  // 全語含有
    return -1;
  };

  const rHits = idx.regions.map(r=>{
    const sc = scoreHay(r.hay);
    return sc>0 ? {...r, score:sc} : null;
  }).filter(Boolean);

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

  // 地域選択：リストのみ更新（SPは一覧へスクロール）
  const pick = (i)=>{
    const h = items[i]; if (!h) return;
    if (h.type === 'region'){
      selectRegionForList(h.name, h.flag);
    }else{
      const spot = h.ref;
      openGraphPanel(spot); // 一覧はそのまま
    }
    closeSuggest();
  };

  // 入力のたびに一覧も更新
  const doSearch = (q)=>{
    const hits = searchEverything(idx, q, 200);
    renderSuggest(hits);
    const list = q.trim() ? hitsToSpotList(hits, 200) : ALL.slice(0, 80);
    renderResults(list);
  };

  let t; input.addEventListener('input', ()=>{
    clearTimeout(t);
    t = setTimeout(()=> doSearch(input.value), 100);
  });

  input.addEventListener('keydown', (e)=>{
    if (e.isComposing) return;
    if (!box.hidden){
      if (e.key === 'ArrowDown'){ e.preventDefault(); active = Math.min(items.length-1, active+1); updateActive(); return; }
      if (e.key === 'ArrowUp'){   e.preventDefault(); active = Math.max(0, active-1); updateActive(); return; }
    }
    if (e.key === 'Enter'){
      if (active >= 0 && !box.hidden){ e.preventDefault(); pick(active); }
      else { e.preventDefault(); closeSuggest(); }
    }else if (e.key === 'Escape'){ closeSuggest(); }
  });
  function updateActive(){ [...box.children].forEach((el,i)=> el.classList.toggle('is-active', i===active)); }

  form.addEventListener('submit', (e)=>{ if (e.isComposing) return; e.preventDefault(); closeSuggest(); });
  const btn = form.querySelector('.head-btn');
  if (btn){ btn.addEventListener('click', (e)=>{ e.preventDefault(); closeSuggest(); }); }

  document.addEventListener('click', (e)=>{ if (!form.contains(e.target)) closeSuggest(); }, true);
}

/* ========= 国バー（header直下の横スクロール） ========= */
// HTML側に <nav id="country-bar"><div id="country-scroll"></div></nav> がある前提。
// なければ自動生成して header 直下に挿入。
function ensureCountryBarShell(){
  let bar = document.getElementById('country-bar');
  if (!bar){
    const header = document.querySelector('.page-head') || document.querySelector('header');
    bar = document.createElement('nav');
    bar.id = 'country-bar';
    bar.className = 'country-bar';
    const inner = document.createElement('div');
    inner.id = 'country-scroll';
    inner.className = 'country-scroll';
    bar.appendChild(inner);
    if (header && header.parentElement){
      header.parentElement.insertBefore(bar, header.nextSibling);
    }else{
      document.body.prepend(bar);
    }
  }else if (!bar.querySelector('#country-scroll')){
    const inner = document.createElement('div');
    inner.id = 'country-scroll';
    inner.className = 'country-scroll';
    bar.appendChild(inner);
  }
  return bar.querySelector('#country-scroll');
}

// ★リストだけ更新（共通ハンドラ）
function selectRegionForList(regionName, flagCode=''){
  const spots = ALL.filter(s => (s.region||'').trim() === regionName);
  renderResults(spots);
  setListLabel(regionName, flagCode);
  scrollToListIfSP();
}

function buildCountryBar(points){
  const wrap = ensureCountryBarShell();
  if (!wrap) return;

  // region + country_code でユニーク化
  const byKey = new Map();
  for (const p of points){
    const region = (p.region || '').trim();
    const cc = (p.country_code || '').toLowerCase().trim();
    if (!region || !cc) continue;
    const key = `${region}__${cc}`;
    if (!byKey.has(key)) byKey.set(key, { region, cc, spots: [] });
    byKey.get(key).spots.push(p);
  }
  const countries = [...byKey.values()].sort((a,b)=> a.region.localeCompare(b.region, 'ja'));

  wrap.innerHTML = '';

  // 「All」
  const allBtn = document.createElement('button');
  allBtn.className = 'country-pill is-active';
  allBtn.dataset.key = 'ALL';
  allBtn.innerHTML = `
    <span style="display:inline-block;width:18px;height:18px;border-radius:4px;background:#223049"></span>
    <span>All</span>
    <span class="cnt">${points.length}</span>
  `;
  wrap.appendChild(allBtn);

  // 各国
  for (const c of countries){
    const btn = document.createElement('button');
    btn.className = 'country-pill';
    btn.dataset.key = `${c.region}__${c.cc}`;
    btn.innerHTML = `
      <span class="flag"><span class="flag-icon flag-icon-${c.cc} flag-icon-squared"></span></span>
      <span class="label">${c.region}</span>
      <span class="cnt">${c.spots.length}</span>
    `;
    wrap.appendChild(btn);
  }

  // クリック動作（委譲）— マップ切替はしない
  wrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('.country-pill');
    if (!btn) return;

    // 見た目のアクティブ切替
    [...wrap.querySelectorAll('.country-pill')].forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    btn.scrollIntoView({ inline:'center', behavior:'smooth', block:'nearest' });

    const key = btn.dataset.key;
    if (key === 'ALL'){
      renderResults(ALL.slice(0, 120));
      setListLabel('', '');
      scrollToListIfSP();
      return;
    }

    const [region, cc] = key.split('__');
    selectRegionForList(region, cc);
  });
}

/* ========= 起動 ========= */
document.addEventListener('DOMContentLoaded', async ()=>{
  const openMapBtn = $('#open-map-btn'); if (openMapBtn) openMapBtn.style.display = 'none';

  // Mapは裏で準備（表示はGlobeのまま）
  initMap('map', { center:[20,0], zoom:3, dark:false });
  wireBackButton();
  showGlobeOnly();

  try{
    const res = await fetch(DATA_URL, { cache:'no-store' });
    ALL = await res.json();

    // 国バー（header直下）
    buildCountryBar(ALL);

    // 地図の国旗レイヤ（地図内の国旗クリック時だけマップ遷移）
    setCountryFlags(ALL, {
      onClick: (_region, spots) => {
        showMapOnly();
        setPointMarkers(spots, { onClick: (s)=> openGraphPanel(s) });
        renderResults(spots); refreshMapSize();
        setListLabel(_region, (spots[0]?.country_code||'').toLowerCase());
      }
    });

    // 検索（日本語対応）
    const idx = buildSearchIndex(ALL);
    initHeaderSearch(idx);

    // Graph/Guide の常設セクションを先に作っておく
    ensureGraphPanel();

    // Globe（クリックでリストのみ更新）
    await renderGlobe();

    // 初期表示：右リストは全体の一部／ラベルはデフォルト
    renderResults(ALL.slice(0, 80));
    setListLabel('', '');

  }catch(e){
    console.error('ポイントデータ読み込み失敗:', e);
    ensureListLabel(); setListLabel('', '');
    renderResults([]);
    ensureGraphPanel();
  }

  window.addEventListener('resize', ()=> isMapMode && refreshMapSize(60));
});
