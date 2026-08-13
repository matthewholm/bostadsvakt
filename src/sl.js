// SL:s öppna Transport-API – kräver INGEN nyckel alls.
//   https://transport.integration.sl.se/v1/sites?expand=true
//   https://transport.integration.sl.se/v1/sites/{siteId}/departures
//
// Varför utöver ResRobot? Norrtälje kommun ligger i Stockholms län och
// trafikeras av SL, och det är just där de glesa linjerna finns – SL:s eget
// API namnger hållplatserna och linjerna exakt som de heter i SL-appen, och
// avslöjar när en "hållplats" i praktiken bara trafikeras av närtrafik som
// måste bokas i förväg.
//
// Lagret är medvetet ett BONUSLAGER: allt här är inlindat så att ett fel
// aldrig stoppar körningen. ResRobot (som redan har nyckel och täcker både
// SL och UL) är basen för turtäthet; det här förfinar bilden när huset
// ligger i SL-land.

const BAS = "https://transport.integration.sl.se/v1";

// Alla SL-hållplatser hämtas en gång per körning och återanvänds för alla
// hus – listan är stor och ändras inte under en körning.
let sajterCache = null;

async function hamtaSajter() {
  if (sajterCache) return sajterCache;
  try {
    const res = await fetch(`${BAS}/sites?expand=true`, {
      headers: { "User-Agent": "bostadsvakt (github.com/matthewholm/bostadsvakt)" },
    });
    if (!res.ok) {
      console.warn(`  SL Transport svarade ${res.status} på sajtlistan – hoppar över SL-detaljerna.`);
      sajterCache = [];
      return sajterCache;
    }
    const data = await res.json();
    sajterCache = (Array.isArray(data) ? data : []).filter((s) => s?.lat != null && s?.lon != null);
    console.log(`  SL Transport: ${sajterCache.length} hållplatser inlästa (nyckelfritt API).`);
  } catch (err) {
    console.warn(`  SL Transport nåddes inte (${err.message}) – hoppar över SL-detaljerna.`);
    sajterCache = [];
  }
  return sajterCache;
}

const R = (d) => (d * Math.PI) / 180;
export function meterMellan(lat1, lon1, lat2, lon2) {
  const dLat = R(lat2 - lat1);
  const dLon = R(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(R(lat1)) * Math.cos(R(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(a)));
}

// Närmaste SL-hållplatser inom `radie` meter.
export async function slNarmasteSajter(lat, lon, radie = 3000, antal = 5) {
  const sajter = await hamtaSajter();
  if (!sajter.length) return [];
  return sajter
    .map((s) => ({ id: s.id, namn: s.name, avstand: meterMellan(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.avstand <= radie)
    .sort((a, b) => a.avstand - b.avstand)
    .slice(0, antal);
}

// SL markerar anropsstyrd trafik både i linjenamn ("Närtrafik") och i
// avvikelsetexter. Vi läser båda.
const NARTRAFIK_MONSTER = /(närtrafik|nartrafik|anropsstyrd|beställningstrafik|förbokas|förbeställ)/i;

// Avgångar från en SL-hållplats inom kommande `minuter`.
// Returnerar null om API:t inte svarar – anroparen faller då tillbaka på
// ResRobot istället för att dra slutsatsen "inga avgångar".
export async function slAvgangar(siteId, minuter = 720) {
  try {
    const res = await fetch(`${BAS}/sites/${siteId}/departures?forecast=${minuter}`, {
      headers: { "User-Agent": "bostadsvakt (github.com/matthewholm/bostadsvakt)" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const avgangar = Array.isArray(data?.departures) ? data.departures : [];

    const linjer = new Set();
    const nartrafikLinjer = new Set();
    for (const d of avgangar) {
      const beteckning = d?.line?.designation ?? d?.line?.id;
      const namn = [beteckning, d?.line?.group_of_lines, d?.destination].filter(Boolean).join(" ");
      if (beteckning) linjer.add(String(beteckning));
      if (NARTRAFIK_MONSTER.test(namn)) nartrafikLinjer.add(String(beteckning ?? namn));
    }

    // Avvikelsetexter på hållplatsen kan också avslöja bokningskrav
    const avvikelser = Array.isArray(data?.stop_deviations) ? data.stop_deviations : [];
    const kraverBokning =
      nartrafikLinjer.size > 0 ||
      avvikelser.some((a) => NARTRAFIK_MONSTER.test(String(a?.message ?? "")));

    return {
      antal: avgangar.length,
      linjer: [...linjer],
      nartrafikLinjer: [...nartrafikLinjer],
      kraverBokning,
      fonsterMin: minuter,
    };
  } catch {
    return null;
  }
}
