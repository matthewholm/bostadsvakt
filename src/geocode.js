// Slår upp koordinater för en adress via OpenStreetMaps Nominatim (gratis).
// Policyn kräver max 1 anrop/sekund – anroparen pausar mellan uppslag.
export async function geokoda(fraga) {
  const params = new URLSearchParams({
    q: fraga,
    format: "json",
    limit: "1",
    countrycodes: "se",
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "User-Agent": "bostadsvakt (github.com/mathiasmholm/bostadsvakt)" },
    });
    if (!res.ok) return null;
    const traffar = await res.json();
    if (!traffar[0]) return null;
    return { lat: Number(traffar[0].lat), lon: Number(traffar[0].lon) };
  } catch {
    return null;
  }
}
