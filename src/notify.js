// Skickar push-notiser via en Home Assistant-webhook, som en automation i HA
// skickar vidare till appen/apparna. Går HA inte att nå – Cloudflares
// botskydd framför home.houseofholm.se började svara 403 till GitHubs
// servrar i slutet av september och tystade alla notiser i över en vecka –
// skickas notisen direkt till ntfy.sh istället (NTFY_TOPIC, samma topic som
// båda telefonerna prenumererar på). Utan någon av dem loggas den bara.
export async function notis({ titel, meddelande, lank, lat, lon, bild, prioritet }) {
  const url = process.env.HA_WEBHOOK_URL;
  if (!url && !process.env.NTFY_TOPIC) {
    console.log(`\n[TORRKÖRNING – varken HA_WEBHOOK_URL eller NTFY_TOPIC satt]\n${titel}\n${meddelande}\n${lank ?? ""}`);
    return;
  }
  const karta = lat != null && lon != null ? `https://www.google.com/maps?q=${lat},${lon}` : "";
  if (url) {
    try {
      const res = await fetch(url, {
        method: "POST",
        // Vissa reverse proxies/WAF:er (t.ex. Cloudflares bot-skydd) blockerar
        // POST-anrop utan en tydlig User-Agent – ärligt identifierad, inte en
        // förfalskad webbläsar-UA, eftersom detta är en betrodd egen tjänst.
        headers: { "Content-Type": "application/json", "User-Agent": "Bostadsvakt-bot/1.0 (+github.com/matthewholm/bostadsvakt)" },
        body: JSON.stringify({ title: titel, message: meddelande, url: lank ?? "", karta, bild: bild ?? "" }),
      });
      if (res.ok) return;
      console.warn(`HA-webhook svarade ${res.status} (server: ${res.headers.get("server") ?? "okänd"}) – provar ntfy.`);
    } catch (err) {
      console.warn(`HA-webhook nåddes inte: ${err.message} – provar ntfy.`);
    }
  }
  await ntfy({ titel, meddelande, lank, karta, bild, prioritet });
}

async function ntfy({ titel, meddelande, lank, karta, bild, prioritet }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.warn("  NTFY_TOPIC saknas – notisen kom inte fram.");
    return;
  }
  const actions = [
    lank && { action: "view", label: "Öppna annonsen", url: lank },
    karta && { action: "view", label: "Visa på karta", url: karta },
  ].filter(Boolean);
  try {
    // JSON-varianten av ntfy:s API, eftersom rubriker i HTTP-headers inte
    // klarar å/ä/ö pålitligt.
    const res = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title: titel,
        message: meddelande,
        priority: prioritet ?? 3,
        ...(lank ? { click: lank } : {}),
        ...(bild ? { attach: bild } : {}),
        ...(actions.length ? { actions } : {}),
      }),
    });
    if (!res.ok) console.warn(`  ntfy svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.warn(`  ntfy nåddes inte: ${err.message}`);
  }
}
