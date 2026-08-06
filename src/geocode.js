// Slår upp koordinater för en adress via OpenStreetMap-tjänster.
// Nominatim provas först men stryper ofta delade molnservrar (t.ex.
// GitHub Actions), så Photon används som reserv. Max 1 anrop/sekund
// mot Nominatim – anroparen pausar mellan uppslag.
//
// Booli-annonser saknar ort i adressen, så anroparen provar samma gatuadress
// med varje bevakat område tillagt (se byggFragor i mailsource.js) tills en
// lyckas. Utan verifiering nedan skulle den första geokodaren som *någon*
// träff för (t.ex. en gata med samma namn i fel stad) accepteras blint,
// vilket placerade husen på fel plats på kartan om ordet på gatan råkade
// finnas i ett tidigare prövat område. Om `ort` anges avvisas därför träffar
// vars retur-adress inte nämner den orten, så anroparen går vidare till
// nästa område i listan istället för att acceptera en felaktig träff.
const UA = { "User-Agent": "bostadsvakt (github.com/matthewholm/bostadsvakt)" };

export async function geokoda(fraga, ort) {
  return (await nominatim(fraga, ort)) ?? (await photon(fraga, ort));
}

function matcharOrt(kandidater, ort) {
  if (!ort) return true;
  const o = ort.toLowerCase();
  return kandidater
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .some((k) => k.includes(o) || o.includes(k));
}

async function nominatim(fraga, ort) {
  const params = new URLSearchParams({ q: fraga, format: "json", limit: "1", countrycodes: "se", addressdetails: "1" });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: UA });
    if (!res.ok) {
      console.warn(`  Nominatim svarade ${res.status} – provar Photon.`);
      return null;
    }
    const traffar = await res.json();
    const t = traffar[0];
    if (!t) return null;
    const a = t.address ?? {};
    if (!matcharOrt([a.municipality, a.city, a.town, a.village, a.hamlet, a.suburb, a.county], ort)) {
      console.warn(`  Nominatim-träff för "${fraga}" ligger inte i ${ort} (fick ${a.municipality ?? a.city ?? a.town ?? "okänd ort"}) – hoppar över.`);
      return null;
    }
    return { lat: Number(t.lat), lon: Number(t.lon) };
  } catch (err) {
    console.warn(`  Nominatim misslyckades (${err.message}) – provar Photon.`);
    return null;
  }
}

async function photon(fraga, ort) {
  // lat/lon nedan viktar träffarna mot Uppsala/Roslagen utan att utesluta annat
  const params = new URLSearchParams({ q: fraga, limit: "1", lat: "59.8", lon: "18.0" });
  try {
    const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: UA });
    if (!res.ok) {
      console.warn(`  Photon svarade ${res.status} – ingen geokodning.`);
      return null;
    }
    const data = await res.json();
    const f = data.features?.[0];
    const c = f?.geometry?.coordinates;
    if (!c) return null;
    const p = f.properties ?? {};
    if (!matcharOrt([p.city, p.district, p.county, p.state], ort)) {
      console.warn(`  Photon-träff för "${fraga}" ligger inte i ${ort} (fick ${p.city ?? p.county ?? "okänd ort"}) – hoppar över.`);
      return null;
    }
    return { lat: c[1], lon: c[0] };
  } catch (err) {
    console.warn(`  Photon misslyckades (${err.message}) – ingen geokodning.`);
    return null;
  }
}
