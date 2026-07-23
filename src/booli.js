// Klient för Boolis öppna API (https://api.booli.se).
// Kräver BOOLI_CALLER_ID och BOOLI_PRIVATE_KEY, se README för hur du skaffar dem.
import crypto from "node:crypto";

const API = "https://api.booli.se";

export function harBooliNycklar() {
  return Boolean(process.env.BOOLI_CALLER_ID && process.env.BOOLI_PRIVATE_KEY);
}

export async function sokAnnonser({ q, objectType = "villa", limit = 100 }) {
  const callerId = process.env.BOOLI_CALLER_ID;
  const privateKey = process.env.BOOLI_PRIVATE_KEY;

  const time = String(Math.floor(Date.now() / 1000));
  const unique = crypto.randomBytes(8).toString("hex");
  const hash = crypto
    .createHash("sha1")
    .update(callerId + time + privateKey + unique)
    .digest("hex");

  const params = new URLSearchParams({
    q,
    objectType,
    limit: String(limit),
    callerId,
    time,
    unique,
    hash,
  });

  const res = await fetch(`${API}/listings?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Booli svarade ${res.status} för "${q}": ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.listings ?? []).map(normalisera);
}

function normalisera(l) {
  return {
    id: `booli-${l.booliId ?? l.id}`,
    pris: l.listPrice ?? null,
    typ: l.objectType ?? "",
    adress: l.location?.address?.streetAddress ?? "Okänd adress",
    ort: l.location?.address?.city ?? l.location?.region?.municipalityName ?? "",
    kommun: l.location?.region?.municipalityName ?? "",
    lat: l.location?.position?.latitude ?? null,
    lon: l.location?.position?.longitude ?? null,
    rum: l.rooms ?? null,
    boarea: l.livingArea ?? null,
    tomtarea: l.plotArea ?? null,
    url: l.url ?? `https://www.booli.se/annons/${l.booliId ?? l.id}`,
    publicerad: l.published ?? null,
  };
}
