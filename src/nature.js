// Uppskattar närhet till vatten och skog samt antal grannhus via OpenStreetMap
// (Overpass API, gratis och utan nyckel). Avstånden är ungefärliga: de mäts
// till objektens mittpunkt, men allt som returneras ligger inom sökradien.
const OVERPASS_SPEGLAR = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const RADIE_NATUR = 1500;
const RADIE_GRANNAR = 300;

export async function naturInfo(lat, lon) {
  const query = `
[out:json][timeout:25];
(
  way(around:${RADIE_NATUR},${lat},${lon})["natural"="water"];
  relation(around:${RADIE_NATUR},${lat},${lon})["natural"="water"];
  way(around:${RADIE_NATUR},${lat},${lon})["natural"="coastline"];
  way(around:${RADIE_NATUR},${lat},${lon})["landuse"="forest"];
  way(around:${RADIE_NATUR},${lat},${lon})["natural"="wood"];
  way(around:${RADIE_GRANNAR},${lat},${lon})["building"];
);
out tags center;`;

  const data = await fragaOverpass(query);
  if (!data) return null;

  let vatten = Infinity;
  let skog = Infinity;
  let byggnader = 0;

  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    if (tags.building) {
      byggnader++;
      continue;
    }
    const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!c) continue;
    // Stora sjöar/skogar kan ha sin mittpunkt långt bort fast kanten är nära –
    // allt som träffas av around-filtret ligger dock inom RADIE_NATUR.
    const d = Math.min(haversine(lat, lon, c.lat, c.lon), RADIE_NATUR);
    if (tags.natural === "water" || tags.natural === "coastline") vatten = Math.min(vatten, d);
    if (tags.landuse === "forest" || tags.natural === "wood") skog = Math.min(skog, d);
  }

  return {
    vattenM: Number.isFinite(vatten) ? Math.round(vatten) : null,
    skogM: Number.isFinite(skog) ? Math.round(skog) : null,
    grannar: Math.max(0, byggnader - 1), // minus huset självt
  };
}

async function fragaOverpass(query) {
  for (const url of OVERPASS_SPEGLAR) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "bostadsvakt (github.com/matthewholm/bostadsvakt)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (res.ok) return await res.json();
      console.warn(`  Overpass (${new URL(url).host}) svarade ${res.status} – provar nästa spegel.`);
    } catch (err) {
      console.warn(`  Overpass (${new URL(url).host}) misslyckades: ${err.message}`);
    }
  }
  console.warn("  Alla Overpass-speglar misslyckades – hoppar över natur-koll.");
  return null;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
