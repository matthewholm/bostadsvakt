// Skickar push-notiser via ntfy.sh med knappar (annons + karta) och
// prioritet. Utan NTFY_TOPIC loggas notisen bara i konsolen.
export async function notis({ titel, meddelande, lank, lat, lon, prioritet }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`\n[TORRKÖRNING – ingen NTFY_TOPIC satt]\n${titel}\n${meddelande}\n${lank ?? ""}`);
    return;
  }

  const body = { topic, title: titel, message: meddelande };
  if (lank) body.click = lank;
  if (prioritet) body.priority = prioritet; // 4 = hög (träffar), 3 = normal

  const knappar = [];
  if (lank) knappar.push({ action: "view", label: "Öppna annonsen", url: lank });
  if (lat != null && lon != null) {
    knappar.push({ action: "view", label: "Visa på karta", url: `https://www.google.com/maps?q=${lat},${lon}` });
  }
  if (knappar.length) body.actions = knappar;

  const res = await fetch("https://ntfy.sh", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn(`ntfy svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
