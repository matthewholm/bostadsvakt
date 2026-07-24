// Skickar push-notiser via ntfy.sh (knappar + prioritet + bild) och, om
// HA_WEBHOOK_URL är satt, även till en Home Assistant-webhook som kan skicka
// vidare till er HA-app. Utan NTFY_TOPIC loggas notisen bara i konsolen.
export async function notis({ titel, meddelande, lank, lat, lon, prioritet, bild }) {
  await skickaHaWebhook({ titel, meddelande, lank, lat, lon, bild });

  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`\n[TORRKÖRNING – ingen NTFY_TOPIC satt]\n${titel}\n${meddelande}\n${lank ?? ""}`);
    return;
  }

  const body = { topic, title: titel, message: meddelande };
  if (lank) body.click = lank;
  if (prioritet) body.priority = prioritet; // 4 = hög (träffar), 3 = normal
  if (bild) body.attach = bild; // husbild ur bevakningsmejlet

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

// Postar notisen till en Home Assistant-webhook (best-effort – fel loggas men
// stoppar inte körningen). En automation i HA kan skicka vidare till HA-appen.
async function skickaHaWebhook({ titel, meddelande, lank, lat, lon, bild }) {
  const url = process.env.HA_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: titel,
        message: meddelande,
        url: lank ?? "",
        karta: lat != null && lon != null ? `https://www.google.com/maps?q=${lat},${lon}` : "",
        bild: bild ?? "",
      }),
    });
    if (!res.ok) console.warn(`HA-webhook svarade ${res.status}`);
  } catch (err) {
    console.warn(`HA-webhook nåddes inte: ${err.message}`);
  }
}
