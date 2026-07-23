// Hittar närmaste hållplats via Trafiklabs ResRobot-API (täcker både SL och UL).
// Kräver RESROBOT_API_KEY – gratis nyckel från https://developer.trafiklab.se.

// Hafas produktbitar: 1/2 = tåg, 8 = pendel-/lokaltåg, 16 = tunnelbana
const TAG_PRODUKTER = 1 | 2 | 8 | 16;

export function harResrobotNyckel() {
  return Boolean(process.env.RESROBOT_API_KEY);
}

// Stockholm Centralstation i ResRobots nationella hållplatsregister
const STOCKHOLM_C = "740000001";

// Snabbaste resan (i minuter) med kollektivtrafik till Stockholm C, avresa nu.
export async function restidTillStockholm(lat, lon) {
  if (!harResrobotNyckel()) return null;

  const params = new URLSearchParams({
    originCoordLat: String(lat),
    originCoordLong: String(lon),
    destId: STOCKHOLM_C,
    format: "json",
    accessId: process.env.RESROBOT_API_KEY,
  });

  const res = await fetch(`https://api.resrobot.se/v2.1/trip?${params}`);
  if (!res.ok) {
    console.warn(`  ResRobot (resa) svarade ${res.status} – hoppar över restidskoll.`);
    return null;
  }
  const data = await res.json();
  const minuter = (data.Trip ?? [])
    .map((t) => tolkaDuration(t.duration))
    .filter((m) => m != null);
  return minuter.length ? Math.min(...minuter) : null;
}

// "PT1H23M" → 83
function tolkaDuration(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d ?? "");
  if (!m) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
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
