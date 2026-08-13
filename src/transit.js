// Pendlingsanalys via Trafiklabs ResRobot (täcker HELA Sverige – både SL och
// UL, samma nyckel som redan används) förfinat med SL:s nyckelfria
// Transport-API där huset ligger i SL-land.
//
// Tre saker är omgjorda mot tidigare version:
//
// 1. BILJETTER. Förut flaggades "⚠ Flera trafikbolag (UL + SJ) – kan kräva
//    separata biljetter" så fort mer än ett operatörsnamn dök upp i resan.
//    Det är fel på två sätt: dels är byte mellan SL-buss och pendeltåg två
//    operatörsnamn men EN biljett, dels är det länsgränsen – inte antalet
//    bolag – som avgör. Nu utgår vi från husets län (se lan.js): Norrtälje
//    ligger i Stockholms län och behöver en SL-biljett, punkt.
//
// 2. TURTÄTHET. Förut visste vi bara att en resa existerade, aldrig om det
//    gick en buss i timmen eller en enda på morgonen. Nu räknas faktiska
//    avgångar en vanlig vardag från närmaste hållplats.
//
// 3. ANROPSSTYRD TRAFIK. "För vissa i Norrtälje går det ingen buss, man måste
//    beställa." Det syns nu explicit istället för att gömmas bakom en
//    hållplats som ser helt vanlig ut på kartan.
import { biljettrad, myndighetForKommun, SL as SL_MYND, UL as UL_MYND } from "./lan.js";
import { slNarmasteSajter, slAvgangar } from "./sl.js";

// Hafas produktbitar: 1/2 = fjärrtåg, 8 = pendel-/lokaltåg, 16 = tunnelbana
const TAG_PRODUKTER = 1 | 2 | 8 | 16;

// Stockholm Centralstation i ResRobots nationella hållplatsregister
const STOCKHOLM_C = "740000001";

export function harResrobotNyckel() {
  return Boolean(process.env.RESROBOT_API_KEY);
}

// Nästa vardagsmorgon (imorgon, eller måndag om imorgon är helg), 07:30.
// Utan explicit datum/tid söker ResRobot "avresa nu" – för glesa
// landsbygdslinjer ger det ofta ett tomt svar mitt på dagen eller på helgen
// trots att det finns en fullt fungerande pendlingsresa. En fast referens på
// en vanlig arbetsdagsmorgon speglar bättre det man vill veta: hur bra är
// pendlingen, inte "går det en buss just denna sekund".
function nastaVardag() {
  const d = new Date();
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().slice(0, 10);
}

async function resrobot(sokvag, params) {
  const p = new URLSearchParams({ format: "json", accessId: process.env.RESROBOT_API_KEY, ...params });
  const res = await fetch(`https://api.resrobot.se/v2.1/${sokvag}?${p}`);
  if (!res.ok) {
    console.warn(`  ResRobot (${sokvag}) svarade ${res.status}.`);
    return null;
  }
  return res.json();
}

const somLista = (x) => (Array.isArray(x) ? x : x ? [x] : []);

// "PT1H23M" → 83
function tolkaDuration(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d ?? "");
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

// Texter som betyder "den här turen måste bokas i förväg".
const BOKNING_MONSTER = /(anropsstyr|beställningstrafik|förbeställ|förbokas|måste bokas|närtrafik|nartrafik|ring och boka)/i;

// ---- Resa till ett mål ----------------------------------------------------

// `franMyndighet`/`tillMyndighet` är SL- eller UL-objekten ur lan.js, härledda
// ur husets respektive målets KOMMUN. De avgör biljettbeskedet – inte vilka
// bolag som råkar nämnas i svaret.
async function resaTillMal(lat, lon, { destId, destLat, destLon, franMyndighet, tillMyndighet }) {
  if (!harResrobotNyckel()) return null;

  const params = {
    originCoordLat: String(lat),
    originCoordLong: String(lon),
    date: nastaVardag(),
    time: "07:30",
  };
  if (destId) params.destId = destId;
  else {
    params.destCoordLat = String(destLat);
    params.destCoordLong = String(destLon);
  }

  let data;
  try {
    data = await resrobot("trip", params);
  } catch (err) {
    console.warn(`  ResRobot (resa) misslyckades: ${err.message}`);
    return null;
  }
  if (!data) return null;

  const resor = somLista(data.Trip)
    .map((trip) => ({ trip, minuter: tolkaDuration(trip.duration) }))
    .filter((r) => r.minuter != null);
  if (!resor.length) return null;

  // Flaggorna ska gälla den resa vi faktiskt rapporterar tiden för (den
  // snabbaste), inte något annat alternativ – annars stämmer inte varningen
  // med resan man läser om.
  const basta = resor.reduce((a, b) => (b.minuter < a.minuter ? b : a));
  const { operatorer, byten, bokning } = analyseraResa(basta.trip);

  return {
    restidMin: basta.minuter,
    byten,
    operatorer,
    // Biljettbeskedet kommer från länen, inte från operatörslistan.
    biljett: biljettrad(franMyndighet, tillMyndighet),
    bokning,
  };
}

export async function resaTillStockholm(lat, lon, franMyndighet) {
  // Stockholm C ligger i Stockholms län → alltid SL i andra änden.
  return resaTillMal(lat, lon, { destId: STOCKHOLM_C, franMyndighet, tillMyndighet: SL_MYND });
}

// Fritt andra pendlingsmål (t.ex. en arbetsplats). `tillMyndighet` slås upp
// en gång i index.js när målet geokodas.
export async function resaTillAndraMalet(lat, lon, malLat, malLon, franMyndighet, tillMyndighet) {
  return resaTillMal(lat, lon, { destLat: malLat, destLon: malLon, franMyndighet, tillMyndighet });
}

// Läser ut operatörer, antal byten och ev. bokningskrav ur en resa.
// Operatörslistan är numera bara upplysning ("SL, Mälartåg") – den styr inte
// längre någon varning om separata biljetter.
function analyseraResa(trip) {
  const legs = somLista(trip?.LegList?.Leg);
  const operatorer = new Set();
  const bokning = new Set();
  let fordonsben = 0;

  for (const leg of legs) {
    const produkter = somLista(leg?.Product);
    if (!produkter.length) continue; // gångsträckor saknar Product
    fordonsben++;

    for (const p of produkter) {
      const operator = p?.operator || p?.admin || p?.operatorCode;
      if (operator) operatorer.add(String(operator).trim());
    }

    for (const n of somLista(leg?.Notes?.Note)) {
      const text = String(n?.value ?? n?.text ?? "").trim();
      if (text && BOKNING_MONSTER.test(text)) bokning.add(text);
    }
    // Linjenamnet självt avslöjar ofta närtrafiken ("Närtrafik 998")
    const linje = String(leg?.name ?? leg?.Product?.[0]?.name ?? "");
    if (BOKNING_MONSTER.test(linje)) bokning.add(`Linjen "${linje.trim()}" är anropsstyrd och måste bokas i förväg.`);
  }

  return {
    operatorer: [...operatorer],
    byten: Math.max(0, fordonsben - 1),
    bokning: [...bokning],
  };
}

// ---- Närmaste hållplatser ------------------------------------------------

export async function narmasteHallplatser(lat, lon, myndighet) {
  if (!harResrobotNyckel()) return null;

  let data;
  try {
    data = await resrobot("location.nearbystops", {
      originCoordLat: String(lat), originCoordLong: String(lon), r: "3000", maxNo: "25",
    });
  } catch (err) {
    console.warn(`  ResRobot (hållplatser) misslyckades: ${err.message}`);
    return null;
  }
  if (!data) return null;

  const stopp = somLista(data.stopLocationOrCoordLocation)
    .map((x) => x.StopLocation)
    .filter(Boolean)
    .map((s) => ({
      // extId är det nationella hållplats-id:t som departureBoard vill ha
      id: String(s.extId ?? s.id ?? ""),
      namn: s.name,
      avstand: Number(s.dist ?? 0),
      produkter: Number(s.products ?? 0),
    }))
    .sort((a, b) => a.avstand - b.avstand);

  const resultat = {
    narmaste: stopp[0] ?? null,
    narmasteTag: stopp.find((s) => s.produkter & TAG_PRODUKTER) ?? null,
    alla: stopp,
  };

  // I SL-land: komplettera med SL:s egen hållplatsbild (rätt namn/linjer).
  if (myndighet?.kod === "SL") {
    try {
      const slStopp = await slNarmasteSajter(lat, lon, 3000, 3);
      if (slStopp.length) resultat.sl = slStopp;
    } catch { /* bonuslager – aldrig fatalt */ }
  }

  return resultat;
}

// ---- Turtäthet ------------------------------------------------------------

// Fönstret vi mäter i: 06:00–20:00 en vanlig vardag (840 min). Det täcker
// både rusning och kvällstur utan att räkna nattrafik som ingen pendlar med.
const FONSTER_START = "06:00";
const FONSTER_MIN = 840;

// Klassificering utifrån antal avgångar i fönstret. Trösklarna är valda så de
// motsvarar hur man faktiskt pratar om trafik: 14 avgångar på 14 timmar är
// "ungefär en i timmen".
function klassa(antal) {
  if (antal === 0) return { klass: "ingen", text: "Ingen linjelagd trafik i tidtabellen" };
  if (antal <= 4) return { klass: "enstaka", text: `Endast ${antal} avgångar per vardag` };
  if (antal <= 13) return { klass: "gles", text: `Gles trafik – ${antal} avgångar per vardag` };
  if (antal <= 28) return { klass: "timme", text: `Ungefär timmestrafik – ${antal} avgångar per vardag` };
  if (antal <= 56) return { klass: "halvtimme", text: `Halvtimmestrafik – ${antal} avgångar per vardag` };
  return { klass: "tat", text: `Tät trafik – ${antal} avgångar per vardag` };
}

// 40 avgångar/vardag (≈ var 20:e minut) ger full poäng. Noll ger noll – och
// det är själva poängen: ett hus där man måste ringa och beställa bussen ska
// inte få samma pendlingspoäng som ett hus vid en hållplats med kvartstrafik,
// även om restiden till Stockholm råkar bli densamma.
export function turtathetPoang(antalAvgangar) {
  if (antalAvgangar == null) return null;
  return Math.max(0, Math.min(100, Math.round((antalAvgangar / 40) * 100)));
}

// Hur ofta går det från hållplatsen en vanlig vardag?
export async function turtathet(stopp, myndighet) {
  if (!harResrobotNyckel() || !stopp?.id) return null;

  let data;
  try {
    data = await resrobot("departureBoard", {
      id: stopp.id,
      date: nastaVardag(),
      time: FONSTER_START,
      duration: String(FONSTER_MIN),
      maxJourneys: "500",
    });
  } catch (err) {
    console.warn(`  ResRobot (avgångar) misslyckades: ${err.message}`);
    return null;
  }
  if (!data) return null;

  const avgangar = somLista(data.Departure);
  const tider = avgangar.map((d) => String(d.time ?? "").slice(0, 5)).filter(Boolean).sort();
  const linjer = [...new Set(avgangar.map((d) => String(d.name ?? "").trim()).filter(Boolean))];

  // Bokningskrav: både ur avgångarnas noteringar och ur linjenamnen
  const bokning = new Set();
  for (const d of avgangar) {
    for (const n of somLista(d?.Notes?.Note)) {
      const text = String(n?.value ?? n?.text ?? "").trim();
      if (text && BOKNING_MONSTER.test(text)) bokning.add(text);
    }
    if (BOKNING_MONSTER.test(String(d.name ?? ""))) {
      bokning.add(`Linjen "${String(d.name).trim()}" är anropsstyrd och måste bokas i förväg.`);
    }
  }

  const { klass, text } = klassa(avgangar.length);
  const resultat = {
    antal: avgangar.length,
    forsta: tider[0] ?? null,
    sista: tider[tider.length - 1] ?? null,
    linjer: linjer.slice(0, 6),
    klass,
    text,
    poang: turtathetPoang(avgangar.length),
    kraverBokning: bokning.size > 0,
    bokning: [...bokning],
    myndighet: myndighet?.kod ?? null,
  };

  // I SL-land: dubbelkolla mot SL:s eget API. Det namnger närtrafiklinjer
  // tydligare än ResRobot och fångar fall där ResRobot listar en hållplats
  // som ser vanlig ut men bara trafikeras av anropsstyrd trafik.
  if (myndighet?.kod === "SL" && stopp.slId != null) {
    const sl = await slAvgangar(stopp.slId);
    if (sl?.kraverBokning) {
      resultat.kraverBokning = true;
      if (sl.nartrafikLinjer.length) {
        resultat.bokning.push(
          `SL: hållplatsen trafikeras av närtrafik (${sl.nartrafikLinjer.join(", ")}) – ${SL_MYND.nartrafik.bokning}.`
        );
      }
    }
  }

  // Ingen linjetrafik alls men huset ligger ändå i ett trafikområde: då ÄR
  // det anropsstyrd trafik som gäller, även om ingen notering sa det rakt ut.
  if (resultat.antal === 0 && myndighet) {
    resultat.kraverBokning = true;
    if (!resultat.bokning.length) {
      resultat.bokning.push(
        `Ingen linjelagd trafik från ${stopp.namn}. Här gäller ${myndighet.nartrafik.namn} – ${myndighet.nartrafik.bokning}.`
      );
    }
  }

  return resultat;
}

export { SL_MYND, UL_MYND, myndighetForKommun };

// ---- Bil till en hållplats som faktiskt går att pendla från ---------------

// Hur långt det är rimligt att köra för att nå riktig kollektivtrafik. Längre
// än så är det inte längre "pendla med buss", då kör man hela vägen.
const MAX_BIL_MIN = 35;
// Så många hållplatser orkar vi undersöka innan vi ger upp. Varje kandidat
// kostar ett avgångsanrop, och det här körs bara för hus som behöver det.
const MAX_KANDIDATER = 5;
// Under så här många avgångar per vardag är hållplatsen inget alternativ
// heller – då har vi bara flyttat problemet.
const MIN_AVGANGAR = 6;

/**
 * Hittar närmaste hållplats man kan KÖRA till och faktiskt pendla vidare från.
 *
 * Anropas bara när hållplatsen vid huset kräver förbeställning eller saknar
 * linjetrafik. Ett sådant hus är inte nödvändigtvis omöjligt att pendla från –
 * de flesta i Roslagen kör bil till en riktig hållplats och ställer bilen där.
 * Utan det här steget stod det bara "ingen trafik" och huset såg sämre ut än
 * det är.
 *
 * Returnerar hållplatsen, körtiden dit, parkeringen och turtätheten därifrån.
 */
export async function bilTillHallplats(lat, lon, myndighet, uteslut = new Set()) {
  if (!harResrobotNyckel()) return null;

  let data;
  try {
    data = await resrobot("location.nearbystops", {
      originCoordLat: String(lat), originCoordLong: String(lon), r: "30000", maxNo: "60",
    });
  } catch (err) {
    console.warn(`  ResRobot (hållplatser för bilresa) misslyckades: ${err.message}`);
    return null;
  }
  if (!data) return null;

  const kandidater = somLista(data.stopLocationOrCoordLocation)
    .map((x) => x.StopLocation)
    .filter(Boolean)
    .map((s) => ({
      id: String(s.extId ?? s.id ?? ""),
      namn: s.name,
      avstand: Number(s.dist ?? 0),
      produkter: Number(s.products ?? 0),
      lat: Number(s.lat),
      lon: Number(s.lon),
    }))
    .filter((s) => s.id && !uteslut.has(s.id) && Number.isFinite(s.lat))
    // Tågstationer först – de är nästan alltid det riktiga pendlingsalternativet
    // och har infartsparkering – därefter närmast.
    .sort((a, b) => {
      const at = a.produkter & TAG_PRODUKTER ? 0 : 1;
      const bt = b.produkter & TAG_PRODUKTER ? 0 : 1;
      return at !== bt ? at - bt : a.avstand - b.avstand;
    })
    .slice(0, MAX_KANDIDATER);

  const { korTid, parkeringVid, parkeringstext } = await import("./bil.js");

  for (const s of kandidater) {
    const turer = await turtathet(s, myndighet);
    // Har den för få turer, eller kräver den också förbokning, är den inget
    // alternativ – då hade vi bara flyttat problemet en mil bort.
    if (!turer || turer.kraverBokning || turer.antal < MIN_AVGANGAR) continue;

    const bil = await korTid({ lat, lon }, { lat: s.lat, lon: s.lon });
    if (bil.minuter > MAX_BIL_MIN) continue;

    const parkering = await parkeringVid(s.lat, s.lon);
    const resa = await resaTillStockholm(s.lat, s.lon, myndighet);

    return {
      hallplats: s.namn,
      avstandM: s.avstand,
      bilMin: bil.minuter,
      bilKm: bil.km,
      bilUppskattad: bil.uppskattad,
      arTagstation: Boolean(s.produkter & TAG_PRODUKTER),
      parkering,
      parkeringstext: parkeringstext(parkering),
      turtathet: { antal: turer.antal, klass: turer.klass, text: turer.text, forsta: turer.forsta, sista: turer.sista },
      // Hela dörr-till-dörr-tiden, inte bara bussdelen. Det är den siffran man
      // faktiskt jämför hus med.
      totaltTillStockholmMin: resa ? bil.minuter + resa.restidMin : null,
      restidFranHallplatsMin: resa?.restidMin ?? null,
    };
  }
  return null;
}
