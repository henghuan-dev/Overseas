// js/layers.js
export function createClusterOptions() {
  return {
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 45,
    singleMarkerMode: true,
    disableClusteringAtZoom: 12,
    iconCreateFunction: (cluster) => {
      const n = cluster.getChildCount();
      const size = n < 10 ? 'sm' : n < 50 ? 'md' : 'lg';
      return L.divIcon({
        html: `<div class="cl-badge ${size}">${n}</div>`,
        className: 'cl-wrap',
        iconSize: [40, 40],
      });
    },
  };
}

export function makeFlagIcon(countryCode) {
  return L.divIcon({
    html: `<span class="flag-badge">
             <span class="flag-icon flag-icon-${countryCode} flag-icon-squared"></span>
           </span>`,
    className: 'flag-pin',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

/** 🌱 明るい緑色マーカー */
export function makeGreenMarkerIcon() {
  return L.divIcon({
    html: `<div style="
      background:#32cd32;   /* limegreen */
      border:2px solid #fff;
      width:18px; height:18px;
      border-radius:50%;
      box-shadow:0 0 6px rgba(0,0,0,0.4);
    "></div>`,
    className: '', // Leaflet のデフォルトクラスを消す
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}
