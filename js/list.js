// js/list.js — PCは既存グラフ / SPは別iframe（HTML側でCSS切替）に対応した版
// 仕様：
//  - 右リスト：検索／国バーから絞り込み、クリックで「Mapへフォーカス」
//  - SP時は選択後に #chart-host まで自動スクロール（見やすさ向上）
//  - 各ポイント名の右に surf(min~max)m をJST現在時で表示（CSV最優先）
//  - Globe：地域クリックでその地域のポイント一覧を右に表示（先頭は自動選択表示のみ）
//  - ※グラフの動的切替（ポイント別iframe差替）は行いません（PC=既存/ SP=別iframeはHTML+CSSで制御）

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
function scrollToChartIfSP(){
  if (!isSP()) return;
  const panel = $('#chart-host');
  if (panel) panel.scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ===== surf(min/max) 抽出ユーティリティ（JST現在時） ===== */
const CSV_BASE = (() => DATA_URL.replace(/[#?].*$/,'').replace(/[^/]+$/,''))();
// ★ テスト時にこのCSVを全ポイントで最優先に使う。運用時は '' に。
const TEST_CSV_ID = '584204204e65fad6a7709981';

const SURF_CACHE = new Map(); // key=cacheId → "0.3~0.6m"
const CSV_TEXT_CACHE = new Map();

function CSV_CANDIDATES(id){
  const urls = [];
  if (TEST_CSV_ID) urls.push(`${CSV_BASE}${TEST_CSV_ID}.csv`);
  if (id)          urls.push(`${CSV_BASE}${encodeURIComponent(id)}.csv`);
  return urls;
}
function getSpotId(s){
  return (
    s?.spotid || s?.spot_id || s?.spotId ||
    s?.surfline_spot_id || s?.surflineSpotId ||
    s?.id || s?.file_name || ''
  );
}

function fmt1(n){
  if (!Number.isFinite(+n)) return null;
  return (+n).toFixed(1).replace(/\.0$/, '.0');
}

// JST “現在の時”（分秒切り捨て）を UTC ms で
function jstCurrentHourUtcMs(){
  const p = new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Tokyo', hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit'
  }).formatToParts(new Date());
  const y = +p.find(x=>x.type==='year').value;
  const m = +p.find(x=>x.type==='month').value;
  const d = +p.find(x=>x.type==='day').value;
  const h = +p.find(x=>x.type==='hour').value;
  return Date.UTC(y, m-1, d, h, 0, 0, 0);
}

/* --- CSV パース（ダブルクォート対応の簡易実装） --- */
function parseCSV(text){
  const lines = String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.length);
  if (!lines.length) return [];
  const parseLine = (line)=>{
    const out=[]; let cur=''; let inQ=false;
    for (let i=0;i<line.length;i++){
      const ch=line[i];
      if (ch === '"'){
        if (inQ && line[i+1] === '"'){ cur+='"'; i++; }
        else inQ=!inQ;
      }else if (ch === ',' && !inQ){
        out.push(cur); cur='';
      }else{
        cur+=ch;
      }
    }
    out.push(cur);
    return out.map(s=>s.trim());
  };
  const headers = parseLine(lines[0]).map(h => h.replace(/^"|"$/g,''));
  return lines.slice(1).map(line=>{
    const cols = parseLine(line);
    const obj={};
    headers.forEach((h,i)=> obj[h] = (cols[i] ?? '').replace(/^"|"$/g,''));
    return obj;
  });
}

/* --- 行から時刻／min-max を推定 --- */
function rowTimeMs(row){
  for (const k of Object.keys(row)){
    const v = row[k];
    if (v==null || v==='') continue;
    if (/^(epoch|ts)$/i.test(k)){
      const n = Number(v); if (!Number.isFinite(n)) continue;
      return String(v).length>=13 ? n : n*1000;
    }
    if (/(time|date|datetime|iso)/i.test(k)){
      const t = Date.parse(v); if (Number.isFinite(t)) return t;
    }
  }
  return null;
}
function rowMinMax(row){
  const num = (x)=> Number(row[x]);
  const cands = [
    ['min','max'], ['surf_min','surf_max'], ['wave_min','wave_max'],
    ['min_m','max_m'], ['minHeight','maxHeight']
  ];
  for (const [a,b] of cands){
    const mn = num(a), mx = num(b);
    if (Number.isFinite(mn) && Number.isFinite(mx)) return {min:mn, max:mx};
  }
  if (row.surf){
    try{
      const s = String(row.surf).replace(/'/g,'"')
        .replace(/\bTrue\b/g,'true').replace(/\bFalse\b/g,'false').replace(/\bNone\b/g,'null');
      const o = JSON.parse(s);
      const v = o?.surf || o;
      if (typeof v?.min==='number' && typeof v?.max==='number') return {min:v.min, max:v.max};
    }catch(_){}
  }
  return null;
}

/* --- CSV 読み込み（候補URLを上から順に） → レンジ文字列 --- */
async function fetchCSVTextFromCandidates(id){
  const cacheKey = TEST_CSV_ID || id || '__noid__';
  if (CSV_TEXT_CACHE.has(cacheKey)) return CSV_TEXT_CACHE.get(cacheKey);

  const urls = CSV_CANDIDATES(id);
  for (const url of urls){
    try{
      const res = await fetch(url, { cache:'no-store' });
      if (res.ok){
        const t = await res.text();
        CSV_TEXT_CACHE.set(cacheKey, t);
        return t;
      }
    }catch(_){}
  }
  throw new Error('csv not found');
}

async function loadSurfRangeTextByCSV(spot){
  const id = getSpotId(spot);
  const cacheKey = TEST_CSV_ID || id;
  if (!cacheKey) return '';
  if (SURF_CACHE.has(cacheKey)) return SURF_CACHE.get(cacheKey);

  try{
    const csv = await fetchCSVTextFromCandidates(id);
    const rows = parseCSV(csv);
    if (!rows.length){ SURF_CACHE.set(cacheKey,''); return ''; }

    const now = jstCurrentHourUtcMs();
    let best=null, bestDiff=Infinity;

    for (const r of rows){
      const mm = rowMinMax(r); if (!mm) continue;
      const t  = rowTimeMs(r);
      const diff = (t==null) ? 0 : Math.abs(t - now);
      if (diff < bestDiff){ best = mm; bestDiff = diff; }
    }

    const txt = (best && fmt1(best.min)!=null && fmt1(best.max)!=null)
      ? `${fmt1(best.min)}~${fmt1(best.max)}m` : '';

    SURF_CACHE.set(cacheKey, txt);
    return txt;
  }catch(err){
    console.warn('[surf] CSV読み込み失敗:', err);
    SURF_CACHE.set(cacheKey, '');
    return '';
  }
}

/* ===== inline surf → レンジ（フォールバック） ===== */
function coerceSurf(val){
  if (!val) return null;
  if (typeof val === 'object') return val;
  if (typeof val === 'string'){
    try{
      const s = val.replace(/'/g,'"').replace(/\bTrue\b/g,'true').replace(/\bFalse\b/g,'false').replace(/\bNone\b/g,'null');
      return JSON.parse(s);
    }catch(_){ return null; }
  }
  return null;
}
function pickSurfNowFromInline(surfRaw){
  const surf = coerceSurf(surfRaw);
  if (!surf) return null;
  if (typeof surf.min === 'number' && typeof surf.max === 'number'){
    return { min: surf.min, max: surf.max };
  }
  if (Array.isArray(surf)){
    const now = jstCurrentHourUtcMs();
    let best=null, bestDt=Infinity;
    for (const it of surf){
      const ts =
        (typeof it.time==='string' ? Date.parse(it.time) :
         typeof it.ts==='number'   ? (String(it.ts).length>=13? it.ts : it.ts*1000) :
         typeof it.epoch==='number'? (String(it.epoch).length>=13? it.epoch : it.epoch*1000) :
         null);
      const v = it?.surf || it;
      if (ts!=null && typeof v?.min==='number' && typeof v?.max==='number'){
        const d = Math.abs(ts - now);
        if (d < bestDt){ best={min:v.min, max:v.max}; bestDt=d; }
      }
    }
    return best;
  }
  if (typeof surf === 'object'){
    const now = jstCurrentHourUtcMs();
    let best=null, bestDt=Infinity;
    for (const [k,v] of Object.entries(surf)){
      const ts = Date.parse(k); const vv=v?.surf||v;
      if (Number.isFinite(ts) && typeof vv?.min==='number' && typeof vv?.max==='number'){
        const d = Math.abs(ts - now);
        if (d < bestDt){ best={min:vv.min, max:vv.max}; bestDt=d; }
      }
    }
    return best;
  }
  return null;
}
function inlineSurfText(s){
  const r = pickSurfNowFromInline(s?.surf);
  if (!r) return '';
  return `${fmt1(r.min)}~${fmt1(r.max)}m`;
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

/* ========= Globe描画（国クリック→リスト更新） ========= */
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
      selectRegionForList(d.region, d.flag); // 右リスト更新（先頭は選択表示）
    });
    return el;
  });

  g.pointOfView(getGlobePOV(host), 0);

  try{
    const ctrl = g.controls?.();
    if (ctrl){
      ctrl.autoRotate = true;
      ctrl.autoRotateSpeed = 0.5;
      ctrl.enableDamping = true;
      ctrl.dampingFactor = 0.05;
    }
  }catch(_){}

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

/* ========= 右リスト ========= */
function getResultsHost(){
  if (!isMapMode){
    return document.getElementById('results-hero') || document.getElementById('results');
  }
  return document.getElementById('results');
}
function markActiveRow(row){
  const host = getResultsHost(); if (!host) return;
  host.classList.add('has-active');
  host.querySelectorAll('.result-item.is-active').forEach(el => el.classList.remove('is-active'));
  if (row) row.classList.add('is-active');
}
function renderResults(list, opts={}){
  const { autoOpenFirst=false } = opts;
  const wrap = getResultsHost(); if (!wrap) return;
  LAST_LIST = list;

  wrap.innerHTML = '';
  wrap.classList.remove('has-active');

  if (!list || !list.length){
    wrap.innerHTML = '<div class="result-item">該当するポイントがありません</div>';
    if (isMapMode) refreshMapSize();
    return;
  }

  let firstRow = null;

  list.slice(0, 120).forEach((s, idx)=>{
    const row = document.createElement('div');
    row.className = 'result-item';
    row.tabIndex = 0;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = displayName(s);

    const meta = document.createElement('span');
    meta.className = 'surf-range';
    Object.assign(meta.style, { fontSize:'12px', color:'#9BDAD6', marginLeft:'8px', whiteSpace:'nowrap' });
    const inlineTxt = inlineSurfText(s);
    if (inlineTxt) meta.textContent = inlineTxt;
    name.appendChild(meta);
    loadSurfRangeTextByCSV(s).then(txt => { if (txt) meta.textContent = txt; });

    row.appendChild(name);

    row.addEventListener('click', ()=>{
      markActiveRow(row);

      // 同一リージョンのマーカーを並べ、選択スポットへズーム
      const region = (s.region||'').trim();
      const regionSpots = ALL.filter(x => (x.region||'').trim() === region);

      showMapOnly();
      setPointMarkers(regionSpots, { onClick: (x)=> {
        // マーカー→リスト同期（簡易）
        const host = getResultsHost();
        const i = regionSpots.findIndex(r => (r.file_name||'') === (x.file_name||''));
        if (host && i>=0 && host.children[i]) markActiveRow(host.children[i]);
        scrollToChartIfSP();
      }});

      try{
        fitToPoints([s], { animate: true, maxZoom: 10 });
        focusSinglePoint(s, 10);
      }catch(_){}

      refreshMapSize();
      scrollToChartIfSP();
    });

    row.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); row.click(); }
    });

    if (idx === 0) firstRow = row;
    wrap.appendChild(row);
  });

  if (autoOpenFirst && list.length){
    markActiveRow(firstRow);
    // グラフはPC/SPともHTML側で固定表示のため、ここでは何もしない
  }

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
function toHiragana(str=''){
  return String(str).replace(/[\u30A1-\u30FA\u30FD-\u30FF]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}
function normalizeJPBase(str=''){
  return toHiragana(String(str).normalize('NFKC').toLowerCase());
}
function compactForIndex(str=''){
  return String(str).replace(/[^a-z0-9\u3040-\u309F\u4E00-\u9FFF]+/g, '');
}
function makeHay(...fields){
  return compactForIndex(normalizeJPBase(fields.filter(Boolean).join(' ')));
}
function queryTerms(q){
  const base = normalizeJPBase(q||'').trim();
  return base.split(/\s+/).map(compactForIndex).filter(Boolean);
}

function buildSearchIndex(points){
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
    if (hay === joined)                     return 100;
    if (hay.startsWith(joined))             return 85;
    if (terms.every(t => hay.includes(t)))  return 70;
    return -1;
  };

  const rHits = idx.regions.map(r=>{
    const sc = scoreHay(r.hay);
    return sc>0 ? {...r, score:sc} : null;
  }).filter(Boolean);

  const pHits = idx.spots.map(p=>{
    const sc = Math.max(
      scoreHay(p.hay),
      (p.flag && p.flag === kwRaw ? 75 : -1)
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

  const pick = (i)=>{
    const h = items[i]; if (!h) return;
    if (h.type === 'region'){
      selectRegionForList(h.name, h.flag);
    }else{
      const spot = h.ref;
      const regionSpots = ALL.filter(s => (s.region||'').trim() === (spot.region||'').trim());
      showMapOnly();
      setPointMarkers(regionSpots, { onClick: (s)=> {
        const host = getResultsHost();
        const idx = regionSpots.findIndex(r => (r.file_name||'') === (s.file_name||''));
        if (host && idx>=0 && host.children[idx]) markActiveRow(host.children[idx]);
        scrollToChartIfSP();
      }});
      try{
        fitToPoints([spot], { animate:true, maxZoom:10 });
        focusSinglePoint(spot, 10);
      }catch(_){}
      refreshMapSize();
      scrollToChartIfSP();
    }
    closeSuggest();
  };

  const doSearch = (q)=>{
    const hits = searchEverything(idx, q, 200);
    renderSuggest(hits);
    const list = q.trim() ? hitsToSpotList(hits, 200) : ALL.slice(0, 80);
    renderResults(list, { autoOpenFirst: false });
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

/* ========= 国バー（header直下の横スクロール：Allなし） ========= */
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

function selectRegionForList(regionName, flagCode=''){
  const spots = ALL.filter(s => (s.region||'').trim() === regionName);
  renderResults(spots, { autoOpenFirst: true });
  setListLabel(regionName, flagCode);
  scrollToListIfSP();
}

function buildCountryBar(points){
  const wrap = ensureCountryBarShell();
  if (!wrap) return;

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

  wrap.addEventListener('click', (e)=>{
    const btn = e.target.closest('.country-pill');
    if (!btn) return;

    [...wrap.querySelectorAll('.country-pill')].forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    btn.scrollIntoView({ inline:'center', behavior:'smooth', block:'nearest' });

    const [region, cc] = String(btn.dataset.key || '').split('__');
    if (!region) return;
    selectRegionForList(region, cc);
  });
}

/* ========= 起動 ========= */
document.addEventListener('DOMContentLoaded', async ()=>{
  const openMapBtn = $('#open-map-btn'); if (openMapBtn) openMapBtn.style.display = 'none';

  initMap('map', { center:[20,0], zoom:3, dark:false });
  wireBackButton();
  showGlobeOnly();

  try{
    const res = await fetch(DATA_URL, { cache:'no-store' });
    ALL = await res.json();

    buildCountryBar(ALL);

    // 国旗クリック（地図 UI）→ リスト更新＆マーカー配置
    setCountryFlags(ALL, {
      onClick: (_region, spots) => {
        showMapOnly();
        setPointMarkers(spots, { onClick: (s)=> {
          // マーカー→リスト同期（簡易）
          const host = getResultsHost();
          const i = spots.findIndex(r => (r.file_name||'') === (s.file_name||''));
          if (host && i>=0 && host.children[i]) markActiveRow(host.children[i]);
          scrollToChartIfSP();
        }});
        renderResults(spots, { autoOpenFirst: true });
        refreshMapSize();
        setListLabel(_region, (spots[0]?.country_code||'').toLowerCase());
      }
    });

    const idx = buildSearchIndex(ALL);
    initHeaderSearch(idx);

    await renderGlobe();

    renderResults(ALL.slice(0, 80), { autoOpenFirst: true });
    setListLabel('', '');

  }catch(e){
    console.error('ポイントデータ読み込み失敗:', e);
    ensureListLabel(); setListLabel('', '');
    renderResults([]);
  }

  window.addEventListener('resize', ()=> isMapMode && refreshMapSize(60));
});
