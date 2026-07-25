// Hittar närmaste hållplats via Trafiklabs ResRobot-API (täcker både SL och UL).
// Kräver RESROBOT_API_KEY – gratis nyckel från https://developer.trafiklab.se.

// Hafas produktbitar: 1/2 = tåg, 8 = pendel-/lokaltåg, 16 = tunnelbana
const TAG_PRODUKTER = 1 | 2 | 8 | 16;

export function harResrobotNyckel() {
  return Boolean(process.env.RESROBOT_API_KEY);
}

// Stockholm Centralstation i ResRobots nationella hållplatsregister
const STOCKHOLM_C = "740000001";

// Nästa vardagsmorgon (imorgon, eller måndag om imorgon är helg), 07:30.
// Utan explicit datum/tid söker ResRobot "avresa nu" – för glesa
// landsbygdslinjer (typ anropsstyrd trafik som bara kör morgon/kväll på
// vardagar) ger det ofta ett tomt svar mitt på dagen eller på helgen, trots
// att det finns en fullt fungerande pendlingsresa. En fast referenspunkt på
// en vanlig arbetsdagsmorgon speglar bättre det man faktiskt vill veta:
// hur bra är pendlingen, inte "går det en buss just i denna sekund".
function nastaVardagsmorgon() {
  const d = new Date();
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return { date: d.toISOString().slice(0, 10), time: "07:30" };
}

// Snabbaste resan med kollektivtrafik till Stockholm C en vanlig
// vardagsmorgon. Utöver restiden flaggar den (best effort) om resan går via
// flera trafikbolag (typiskt SL + UL runt Uppsala – kan betyda separata
// biljetter) och om någon delsträcka kräver förbeställning (vanligt för
// anropsstyrd trafik i Norrtäljes ytterområden, se skärmdumpen som
// triggade det här).
export async function resaTillStockholm(lat, lon) {
  if (!harResrobotNyckel()) return null;

  const { date, time } = nastaVardagsmorgon();
  const params = new URLSearchParams({
    originCoordLat: String(lat),
    originCoordLong: String(lon),
    destId: STOCKHOLM_C,
    date,
    time,
    format: "json",
    accessId: process.env.RESROBOT_API_KEY,
  });

  const res = await fetch(`https://api.resrobot.se/v2.1/trip?${params}`);
  if (!res.ok) {
    console.warn(`  ResRobot (resa) svarade ${res.status} – hoppar över restidskoll.`);
    return null;
  }
  const data = await res.json();
  const tripRaw = data.Trip;
  const resor = (Array.isArray(tripRaw) ? tripRaw : tripRaw ? [tripRaw] : [])
    .map((trip) => ({ trip, minuter: tolkaDuration(trip.duration) }))
    .filter((r) => r.minuter != null);
  if (!resor.length) return null;

  // Flaggorna gäller den resa vi faktiskt rapporterar tiden för (snabbast),
  // inte något annat alternativ – annars stämmer inte varningen med resan.
  const basta = resor.reduce((a, b) => (b.minuter < a.minuter ? b : a));
  const { operatorer, forbestallning } = analyseraResa(basta.trip);
  return { restidMin: basta.minuter, operatorer, forbestallning };
}

// "PT1H23M" → 83
function tolkaDuration(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d ?? "");
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

const FORBESTALLNING_MONSTER = /(beställ|anropsstyr|förbeställ)/i;

// ResRobots exakta svarsformat för Notes/Product per delsträcka är inte
// dokumenterat i detalj, så vi läser flera tänkbara fältnamn defensivt och
// faller till sist tillbaka på en råtextsökning i hela resan – hellre en
// varning för mycket än att missa en resa som kräver förbeställning.
function analyseraResa(trip) {
  const legRaw = trip?.LegList?.Leg;
  const legs = Array.isArray(legRaw) ? legRaw : legRaw ? [legRaw] : [];

  const operatorer = new Set();
  const forbestallning = new Set();

  for (const leg of legs) {
    const prodRaw = leg?.Product;
    const produkter = Array.isArray(prodRaw) ? prodRaw : prodRaw ? [prodRaw] : [];
    if (!produkter.length) continue; // gångsträckor saknar Product – ointressanta här

    for (const p of produkter) {
      const operator = p?.operator || p?.admin || p?.operatorCode;
      if (operator) operatorer.add(String(operator).trim());
    }

    const noteRaw = leg?.Notes?.Note;
    const notes = Array.isArray(noteRaw) ? noteRaw : noteRaw ? [noteRaw] : [];
    for (const n of notes) {
      const text = String(n?.value ?? n?.text ?? "").trim();
      if (text && FORBESTALLNING_MONSTER.test(text)) forbestallning.add(text);
    }
  }

  if (!forbestallning.size && FORBESTALLNING_MONSTER.test(JSON.stringify(trip ?? {}))) {
    forbestallning.add("Resan kan kräva förbeställning – kontrollera i SL-/UL-appen.");
  }

  return { operatorer: [...operatorer], forbestallning: [...forbestallning] };
}

export async function narmasteHallplatser(lat, lon) {
  if (!harResrobotNyckel()) return null;

  const params = new URLSearchParams({
    originCoordLat: String(lat),
    originCoordLong: String(lon),
    r: "3000",
    maxNo: "25",
    format: "json",
    accessId: process.env.RESROBOT_API_KEY,
  });

  const res = await fetch(`https://api.resrobot.se/v2.1/location.nearbystops?${params}`);
  if (!res.ok) {
    console.warn(`  ResRobot svarade ${res.status} – hoppar över hållplatskoll.`);
    return null;
  }
  const data = await res.json();

  const stopp = (data.stopLocationOrCoordLocation ?? [])
    .map((x) => x.StopLocation)
    .filter(Boolean)
    .map((s) => ({
      namn: s.name,
      avstand: Number(s.dist ?? 0),
      produkter: Number(s.products ?? 0),
    }))
    .sort((a, b) => a.avstand - b.avstand);

  return {
    narmaste: stopp[0] ?? null,
    narmasteTag: stopp.find((s) => s.produkter & TAG_PRODUKTER) ?? null,
  };
}
