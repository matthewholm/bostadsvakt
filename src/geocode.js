// Slår upp koordinater för en adress via OpenStreetMap-tjänster.
// Nominatim provas först men stryper ofta delade molnservrar (t.ex.
// GitHub Actions), så Photon används som reserv. Max 1 anrop/sekund
// mot Nominatim – anroparen pausar mellan uppslag.
const UA = { "User-Agent": "bostadsvakt (github.com/mathiasmholm/bostadsvakt)" };

export async function geokoda(fraga) {
  return (await nominatim(fraga)) ?? (await photon(fraga));
}

async function nominatim(fraga) {
  const params = new URLSearchParams({ q: fraga, format: "json", limit: "1", countrycodes: "se" });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: UA });
    if (!res.ok) {
      console.warn(`  Nominatim svarade ${res.status} – provar Photon.`);
      return null;
    }
    const traffar = await res.json();
    if (!traffar[0]) return null;
    return { lat: Number(traffar[0].lat), lon: Number(traffar[0].lon) };
  } catch (err) {
    console.warn(`  Nominatim misslyckades (${err.message}) – provar Photon.`);
    return null;
  }
}

async function photon(fraga) {
  // lat/lon nedan viktar träffarna mot Uppsala/Roslagen utan att utesluta annat
  const params = new URLSearchParams({ q: fraga, limit: "1", lat: "59.8", lon: "18.0" });
  try {
    const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: UA });
    if (!res.ok) {
      console.warn(`  Photon svarade ${res.status} – ingen geokodning.`);
      return null;
    }
    const data = await res.json();
    const c = data.features?.[0]?.geometry?.coordinates;
    if (!c) return null;
    return { lat: c[1], lon: c[0] };
  } catch (err) {
    console.warn(`  Photon misslyckades (${err.message}) – ingen geokodning.`);
    return null;
  }
}
