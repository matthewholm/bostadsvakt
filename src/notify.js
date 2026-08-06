// Skickar push-notiser via en Home Assistant-webhook, som en automation i HA
// skickar vidare till appen/apparna. Utan HA_WEBHOOK_URL loggas notisen bara
// i konsolen.
export async function notis({ titel, meddelande, lank, lat, lon, bild }) {
  const url = process.env.HA_WEBHOOK_URL;
  if (!url) {
    console.log(`\n[TORRKÖRNING – ingen HA_WEBHOOK_URL satt]\n${titel}\n${meddelande}\n${lank ?? ""}`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      // Vissa reverse proxies/WAF:er (t.ex. Cloudflares bot-skydd) blockerar
      // POST-anrop utan en tydlig User-Agent – ärligt identifierad, inte en
      // förfalskad webbläsar-UA, eftersom detta är en betrodd egen tjänst.
      headers: { "Content-Type": "application/json", "User-Agent": "Bostadsvakt-bot/1.0 (+github.com/matthewholm/bostadsvakt)" },
      body: JSON.stringify({
        title: titel,
        message: meddelande,
        url: lank ?? "",
        karta: lat != null && lon != null ? `https://www.google.com/maps?q=${lat},${lon}` : "",
        bild: bild ?? "",
      }),
    });
    if (!res.ok) {
      console.warn(`HA-webhook svarade ${res.status}`);
      console.warn(`  Server: ${res.headers.get("server") ?? "okänd"}, cf-ray: ${res.headers.get("cf-ray") ?? "saknas"}`);
      console.warn(`  Svarstext: ${(await res.text()).slice(0, 500)}`);
    }
  } catch (err) {
    console.warn(`HA-webhook nåddes inte: ${err.message}`);
  }
}
