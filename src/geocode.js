// Slår upp koordinater för en adress – och VERIFIERAR att träffen faktiskt
// ligger i rätt kommun innan den accepteras.
//
// Bakgrund: den gamla versionen tog emot en valfri `ort` att kontrollera mot,
// men anroparen skickade den inte alltid. `byggFragor` i mailsource.js gav
// Hemnet-annonser (`adressFragor`) helt utan ort, och Booli-annonser fick en
// sista fråga utan ort som "sista chansen". Utan ort returnerade kontrollen
// `true` direkt, så första bästa träff i HELA Sverige accepterades blint.
// Det placerade t.ex. Backbyvägen 184 på Singö (Norrtälje) i Uppsala, och
// Norruddsvägen 6 på latitud 59,09 – nere vid Trosa, åtta mil fel.
//
// Följdfelen blev värre än en felplacerad kartnål: ResRobot planerade resan
// från fel plats, så ett hus i Norrtälje (SL-område) fick "UL + SJ – kan
// kräva separata biljetter", och natur/grannar/restid mättes någon helt
// annanstans, vilket gjorde matchningspoängen meningslös.
//
// Reglerna nu:
//   • En träff accepteras ALDRIG utan att kommunen är verifierad.
//   • Kan vi inte verifiera returnerar vi null. Ett hus utan nål är ärligare
//     än ett hus på fel nål – panelen visar "Plats okänd" och huset räknas
//     inte som Träff, precis som förut när koordinater saknades.
//   • Vi returnerar kommun + län + myndighet (SL/UL) så resten av kedjan
//     slipper gissa, och en `precision` så panelen kan visa när nålen bara
//     är ortsnivå och inte husnivå.
import { myndighetForKommun, kommunForOrt, visaKommun, norm, KOMMUNER } from "./lan.js";

const UA = { "User-Agent": "bostadsvakt (github.com/matthewholm/bostadsvakt)" };

// Uppsala + Stockholms län med marginal. Grovt förfilter – den riktiga
// spärren är kommunkontrollen nedan (Trosa ligger t.ex. innanför rutan men
// avvisas ändå eftersom Trosa kommun inte finns i KOMMUNER).
const RUTA = { lonMin: 16.4, latMin: 58.7, lonMax: 19.5, latMax: 60.8 };
const iRutan = (lat, lon) =>
  lat >= RUTA.latMin && lat <= RUTA.latMax && lon >= RUTA.lonMin && lon <= RUTA.lonMax;

// Nominatims användarvillkor: max 1 anrop/sekund. Anroparen pausar redan
// mellan hus, men vi gör flera försök per hus här, så vi taktar internt också.
let sistaAnrop = 0;
async function takta(minMs = 1100) {
  const vanta = sistaAnrop + minMs - Date.now();
  if (vanta > 0) await new Promise((r) => setTimeout(r, vanta));
  sistaAnrop = Date.now();
}

// Hur exakt är nålen? Nominatims addresstype/Photons type avgör om vi träffat
// ett hus, en gata eller bara orten. Ortsnivå kan ligga kilometervis fel och
// ska inte se lika säker ut som en husnummerträff i panelen.
function tolkaPrecision(typ) {
  const t = norm(typ);
  if (["house", "building", "address", "residential", "yes", "house_number"].includes(t)) return "hus";
  if (["road", "street", "footway", "track", "path"].includes(t)) return "gata";
  if (["village", "town", "city", "hamlet", "locality", "suburb", "municipality", "district"].includes(t)) return "ort";
  return "okänd";
}

// Plockar ut kommunen ur ett Nominatim-adressobjekt. Sverige-svar har normalt
// `municipality` = "Norrtälje kommun" och `county` = "Stockholms län", men
// fälten varierar mellan objekt, så vi provar flera i tur och ordning.
function kommunUrNominatim(a = {}) {
  for (const kandidat of [a.municipality, a.city, a.town, a.village, a.hamlet, a.county]) {
    const n = norm(kandidat);
    if (n && KOMMUNER[n]) return n;
  }
  // Ingen direkt kommunträff – prova ortsnamnet mot ort→kommun-listan
  // (Nominatim svarar ibland bara med "Väddö" utan att nämna Norrtälje).
  for (const kandidat of [a.village, a.hamlet, a.town, a.suburb, a.city]) {
    const k = kommunForOrt(kandidat);
    if (k) return k;
  }
  return null;
}

// Bygger ett verifierat resultat, eller null om kommunen inte går att
// fastställa/ligger utanför bevakningsområdet.
// Exporterad för att kunna testas utan nätverk – det är den här spärren som
// hade fångat samtliga felplaceringar, så den förtjänar egna tester.
export function verifiera({ lat, lon, kommun, precision, kalla, forvantadKommun, fraga }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  if (!iRutan(lat, lon)) {
    console.warn(`  ${kalla}: "${fraga}" hamnade utanför Uppsala/Stockholms län (${lat.toFixed(3)}, ${lon.toFixed(3)}) – avvisas.`);
    return null;
  }
  if (!kommun) {
    console.warn(`  ${kalla}: kunde inte fastställa kommun för "${fraga}" – avvisas hellre än att gissa.`);
    return null;
  }
  const myndighet = myndighetForKommun(kommun);
  if (!myndighet) {
    console.warn(`  ${kalla}: "${fraga}" ligger i ${visaKommun(kommun)}, utanför bevakade län – avvisas.`);
    return null;
  }
  if (forvantadKommun && kommun !== forvantadKommun) {
    console.warn(`  ${kalla}: "${fraga}" gav ${visaKommun(kommun)} men annonsen säger ${visaKommun(forvantadKommun)} – avvisas.`);
    return null;
  }
  return {
    lat, lon,
    kommun,
    kommunNamn: visaKommun(kommun),
    lan: myndighet.lan,
    myndighet: myndighet.kod,
    precision,
    kalla,
  };
}

// ---- Nominatim ----
// Strukturerad sökning (street/city/county) är betydligt träffsäkrare än
// fritext, eftersom "Simpnäsvägen 13 Väddö" annars kan matcha vilken
// Simpnäsväg som helst medan `city=Väddö` binder träffen till rätt ort.
async function nominatim({ adress, ort, lan, forvantadKommun, strukturerad }) {
  const params = new URLSearchParams({
    format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "se",
  });
  if (strukturerad) {
    params.set("street", adress);
    if (ort) params.set("city", ort);
    if (lan) params.set("county", lan);
  } else {
    params.set("q", [adress, ort, lan].filter(Boolean).join(", "));
    // Rutan gäller bara fritextsökningen; strukturerad sökning är redan bunden
    // av city/county och blir onödigt snäv med bounded=1 ovanpå det.
    params.set("viewbox", `${RUTA.lonMin},${RUTA.latMax},${RUTA.lonMax},${RUTA.latMin}`);
    params.set("bounded", "1");
  }

  const fraga = strukturerad ? `${adress} [${ort ?? "-"}]` : params.get("q");
  try {
    await takta();
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: UA });
    if (!res.ok) {
      console.warn(`  Nominatim svarade ${res.status} för "${fraga}".`);
      return null;
    }
    // Flera kandidater: ta den FÖRSTA som verifierar, inte bara den bästa
    // rankade – rankningen bryr sig inte om vilken kommun vi vill ha.
    for (const t of await res.json()) {
      const traff = verifiera({
        lat: Number(t.lat), lon: Number(t.lon),
        kommun: kommunUrNominatim(t.address),
        precision: tolkaPrecision(t.addresstype ?? t.type),
        kalla: "Nominatim", forvantadKommun, fraga,
      });
      if (traff) return traff;
    }
    return null;
  } catch (err) {
    console.warn(`  Nominatim misslyckades för "${fraga}" (${err.message}).`);
    return null;
  }
}

// ---- Photon ----
// Reserv när Nominatim stryper delade molnservrar (vanligt i GitHub Actions).
async function photon({ adress, ort, forvantadKommun }) {
  const fraga = [adress, ort].filter(Boolean).join(", ");
  const params = new URLSearchParams({
    q: fraga, limit: "5", lang: "sv",
    bbox: `${RUTA.lonMin},${RUTA.latMin},${RUTA.lonMax},${RUTA.latMax}`,
  });
  try {
    await takta(300); // Photon har ingen 1/s-regel, men var ändå snäll
    const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: UA });
    if (!res.ok) {
      console.warn(`  Photon svarade ${res.status} för "${fraga}".`);
      return null;
    }
    const data = await res.json();
    for (const f of data.features ?? []) {
      const c = f.geometry?.coordinates;
      if (!c) continue;
      const p = f.properties ?? {};
      // Photon lägger kommunen i `county` för svenska träffar, orten i `city`.
      const kommun =
        [p.county, p.city, p.district, p.locality].map(norm).find((n) => n && KOMMUNER[n]) ??
        kommunForOrt(p.city ?? p.district ?? p.locality ?? p.name);
      const traff = verifiera({
        lat: c[1], lon: c[0], kommun,
        precision: tolkaPrecision(p.osm_value ?? p.type),
        kalla: "Photon", forvantadKommun, fraga,
      });
      if (traff) return traff;
    }
    return null;
  } catch (err) {
    console.warn(`  Photon misslyckades för "${fraga}" (${err.message}).`);
    return null;
  }
}

// ---- Publikt API ----

// Geokodar en adress. `ort` är annonsens egen ort (t.ex. "Väddö"), `omraden`
// är de bevakade områdena ur config.json som sista utväg.
//
// Ordningen är medvetet snävast först: annonsens egen ort ger rätt kommun
// direkt, medan de breda områdena ("Uppsala", "Norrtälje") bara ska användas
// när annonsen inte säger något bättre. Förut provades alltid "Uppsala" först
// för alla hus, vilket är precis varför Roslagen hamnade i Uppsala.
export async function geokoda(adress, { ort = "", kommunText = "", omraden = [] } = {}) {
  if (!adress) return null;

  const kandidatOrter = [];
  const lagg = (o) => {
    const n = norm(o);
    if (n && !kandidatOrter.some((x) => norm(x) === n)) kandidatOrter.push(o);
  };

  // Säger annonsen själv vilken kommun huset ligger i (Hemnets slug och
  // digestmejl gör det) är den avgörande – då provar vi ALDRIG någon annan
  // kommun. Utan den låsningen återuppstår originalbuggen i ny form: om
  // uppslaget på "Väddö" misslyckas skulle vi annars gå vidare till det breda
  // bevakningsområdet "Uppsala" och glatt acceptera en Uppsala-träff för ett
  // hus i Roslagen.
  const lastKommun = kommunForOrt(kommunText) ?? kommunForOrt(ort);

  lagg(ort);
  // "Rimbo Gottröra" och "Vattholma Vargdansen" – första ordet är ofta orten
  if (ort && ort.includes(" ")) lagg(ort.split(" ")[0]);
  lagg(kommunText);
  // Hemnets sluggar är ASCII-translittererade ("vaddo-norrtalje-kommun"), så
  // kandidaterna ovan kan sakna å/ä/ö. Den kanoniska stavningen läggs till
  // eftersom Nominatim hittar "Norrtälje" bättre än "norrtalje".
  if (lastKommun) lagg(visaKommun(lastKommun));
  // De breda bevakningsområdena används BARA när annonsen inte gett oss någon
  // kommun att låsa mot.
  if (!lastKommun) for (const o of omraden) lagg(o);

  for (const kandidat of kandidatOrter) {
    const kommun = lastKommun ?? kommunForOrt(kandidat);
    const myndighet = kommun ? myndighetForKommun(kommun) : null;
    const lan = myndighet?.lan ?? null;

    // 1) Strukturerad Nominatim – precisast när vi vet ort (och därmed län)
    const strukt = await nominatim({ adress, ort: kandidat, lan, forvantadKommun: kommun, strukturerad: true });
    if (strukt) return strukt;

    // 2) Fritext inom rutan
    const fritext = await nominatim({ adress, ort: kandidat, lan, forvantadKommun: kommun, strukturerad: false });
    if (fritext) return fritext;

    // 3) Photon som reserv
    const p = await photon({ adress, ort: kandidat, forvantadKommun: kommun });
    if (p) return p;
  }

  console.warn(`  Ingen verifierad koordinat för "${adress}" (provade orter: ${kandidatOrter.join(", ") || "inga"}) – lämnas utan plats.`);
  return null;
}

// Omvänd uppslagning: koordinater → kommun/län/myndighet. Behövs för annonser
// som redan kommer med koordinater (Boolis API), där vi inte geokodat själva
// men ändå måste veta om huset ligger i SL- eller UL-land innan vi uttalar oss
// om biljetter.
export async function slaUppPlats(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const params = new URLSearchParams({
    lat: String(lat), lon: String(lon), format: "jsonv2", addressdetails: "1", zoom: "10",
  });
  try {
    await takta();
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, { headers: UA });
    if (!res.ok) {
      console.warn(`  Nominatim (reverse) svarade ${res.status} för ${lat},${lon}.`);
      return null;
    }
    const data = await res.json();
    const kommun = kommunUrNominatim(data.address);
    if (!kommun) return null;
    const myndighet = myndighetForKommun(kommun);
    if (!myndighet) return null;
    return {
      kommun, kommunNamn: visaKommun(kommun),
      lan: myndighet.lan, myndighet: myndighet.kod,
    };
  } catch (err) {
    console.warn(`  Nominatim (reverse) misslyckades (${err.message}).`);
    return null;
  }
}
