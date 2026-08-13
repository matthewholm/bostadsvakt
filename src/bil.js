// Bil till hållplatsen – för hus där kollektivtrafiken vid dörren inte går att
// pendla med.
//
// Bakgrund: i Norrtäljes och Uppsalas ytterområden är närmaste "hållplats"
// ofta bara en punkt som trafikeras av anropsstyrd trafik – man måste ringa
// och beställa bussen timmar i förväg. Ett sådant hus såg tidigare ut att ha
// bra pendling ("Hållplats: X · 400 m") fast det i praktiken inte gick att
// pendla därifrån alls.
//
// Men det betyder inte att huset är omöjligt. De flesta i de trakterna kör
// bil till en riktig hållplats eller station och ställer bilen där. Frågan är
// alltså: hur långt är det dit, går det att parkera gratis, och hur ofta går
// det därifrån? Det är vad den här modulen tar reda på.
//
// Båda tjänsterna är gratis och nyckelfria, precis som Overpass och Nominatim
// som redan används. OSRM:s demoserver är "best effort" – svarar den inte
// faller vi tillbaka på en uppskattning utifrån fågelvägen, och säger då
// uttryckligen att det är en uppskattning.
import { fragaOverpass, haversine } from "./nature.js";

const OSRM = "https://router.project-osrm.org/route/v1/driving";
const UA = { "User-Agent": "bostadsvakt (github.com/matthewholm/bostadsvakt)" };

// Landsvägsfart för reservuppskattningen. Medvetet försiktig: småvägar i
// Roslagen är sällan 80 hela vägen, och en för optimistisk siffra är värre
// än en för dyster när man ska välja vilka hus man åker och tittar på.
const RESERV_KMH = 60;

/**
 * Körtid och vägsträcka mellan två punkter.
 * `uppskattad: true` betyder att OSRM inte svarade och att siffran är räknad
 * på fågelvägen × 1,3 – bra nog för att sortera hus, inte för att planera.
 */
export async function korTid(fran, till) {
  const url = `${OSRM}/${fran.lon},${fran.lat};${till.lon},${till.lat}?overview=false`;
  try {
    const res = await fetch(url, { headers: UA });
    if (res.ok) {
      const data = await res.json();
      const rutt = data?.routes?.[0];
      if (data?.code === "Ok" && rutt) {
        return {
          minuter: Math.round(rutt.duration / 60),
          km: Math.round(rutt.distance / 100) / 10,
          uppskattad: false,
        };
      }
    } else {
      console.warn(`  OSRM svarade ${res.status} – uppskattar körtiden istället.`);
    }
  } catch (err) {
    console.warn(`  OSRM nåddes inte (${err.message}) – uppskattar körtiden istället.`);
  }

  // Reserv: fågelvägen med ett påslag för att vägar inte går spikrakt.
  const km = (haversine(fran.lat, fran.lon, till.lat, till.lon) / 1000) * 1.3;
  return { minuter: Math.round((km / RESERV_KMH) * 60), km: Math.round(km * 10) / 10, uppskattad: true };
}

// Parkeringar som inte går att ställa sig på: privata tomter, kundparkeringar
// vid butiker, och sådant som kräver tillstånd.
const STANGD = new Set(["private", "customers", "permissive_private", "no"]);

/**
 * Parkering vid en hållplats, med tonvikt på om den kostar något.
 *
 * OSM-taggen `park_ride=yes` är precis det vi letar efter (infartsparkering).
 * `fee` saknas ofta helt på landsbygden – i praktiken betyder det gratis, men
 * vi säger "avgift okänd" istället för att lova något vi inte vet.
 */
export async function parkeringVid(lat, lon, radie = 500) {
  const query = `
[out:json][timeout:25];
(
  node(around:${radie},${lat},${lon})["amenity"="parking"];
  way(around:${radie},${lat},${lon})["amenity"="parking"];
);
out tags center;`;

  const data = await fragaOverpass(query);
  if (!data) return null;

  const kandidater = [];
  for (const el of data.elements ?? []) {
    const t = el.tags ?? {};
    if (STANGD.has(String(t.access ?? "").toLowerCase())) continue;
    const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!c) continue;

    const avgift = String(t.fee ?? "").toLowerCase();
    kandidater.push({
      namn: t.name || (t.park_ride ? "Infartsparkering" : "Parkering"),
      avstand: Math.round(haversine(lat, lon, c.lat, c.lon)),
      infartsparkering: String(t.park_ride ?? "").toLowerCase() === "yes",
      // Tre lägen, inte två: vi vet att den är gratis, vi vet att den kostar,
      // eller så står det ingenting och då ska vi inte påstå något.
      gratis: avgift === "no" ? true : avgift === "yes" ? false : null,
      platser: t.capacity ? Number(t.capacity) : null,
      maxtid: t.maxstay ?? null,
    });
  }
  if (!kandidater.length) return null;

  // Bäst först: uttalad infartsparkering, sedan gratis, sedan närmast.
  kandidater.sort((a, b) => {
    if (a.infartsparkering !== b.infartsparkering) return a.infartsparkering ? -1 : 1;
    const ag = a.gratis === false ? 1 : 0;
    const bg = b.gratis === false ? 1 : 0;
    if (ag !== bg) return ag - bg;
    return a.avstand - b.avstand;
  });
  return kandidater[0];
}

/** Läsbar rad om parkeringen, eller null när vi inte hittade någon. */
export function parkeringstext(p) {
  if (!p) return null;
  const delar = [p.infartsparkering ? "Infartsparkering" : p.namn];
  if (p.gratis === true) delar.push("gratis");
  else if (p.gratis === false) delar.push("avgift");
  else delar.push("avgift okänd");
  if (p.platser) delar.push(`${p.platser} platser`);
  if (p.maxtid) delar.push(`max ${p.maxtid}`);
  return `${delar.join(" · ")} (${p.avstand} m från hållplatsen)`;
}
