// Kort AI-skriven bedömning per hus (Claude Haiku 4.5 – billigast tillgängliga
// modell, vald för att hålla kostnaden minimal). Jämför husets mätvärden mot
// kriterierna och skriver 2–3 meningar på svenska om vad som är bra och vad
// som är den svaga länken. Rent tillägg: saknas nyckel eller går anropet fel
// skickas ingen bedömning – det avgör aldrig Träff eller poäng.
const MODEL = "claude-haiku-4-5";

export function harAnthropicNyckel() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function skrivBedomning({ adress, typ, fakta, k, pendling, omgivning, poang }) {
  if (!harAnthropicNyckel()) return null;

  const prompt = [
    `Hus: ${adress}${fakta ? ", " + fakta : ""}.`,
    pendling.length ? `Pendling: ${pendling.join(" · ")}.` : "",
    omgivning.length ? `Omgivning: ${omgivning.join(" · ")}.` : "",
    poang != null ? `Matchningspoäng: ${poang}/100.` : "",
    `Krav att bedöma mot: max hållplatsavstånd ${k.maxAvståndHållplatsM} m, ` +
      `max vattenavstånd ${k.maxAvståndVattenM} m, max skogsavstånd ${k.maxAvståndSkogM} m, ` +
      `naturkrav "${k.kravNatur ?? "något"}", max grannar inom 300 m: ${k.maxGrannarInom300m}` +
      (k.maxRestidStockholmMin ? `, max restid Stockholm C ${k.maxRestidStockholmMin} min` : "") + ".",
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system:
          "Du är en kunnig lokalkännare som bedömer villor åt ett par som letar hus nära Uppsala/Norrtälje " +
          "utifrån pendling, natur och avskildhet. Skriv EXAKT 2-3 meningar på svenska: vad som är bra, vad " +
          "som är den svaga länken (om någon), och en ärlig helhetsbild. Var konkret och kortfattad – ingen " +
          "hälsning, ingen rubrik, inga punktlistor.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.warn(`Claude API svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    if (data.stop_reason === "refusal") return null;
    const text = data.content?.find((b) => b.type === "text")?.text;
    return text?.trim() || null;
  } catch (err) {
    console.warn(`Claude API nåddes inte: ${err.message}`);
    return null;
  }
}
