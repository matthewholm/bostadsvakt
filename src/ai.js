// Kort AI-skriven bedömning per hus (Claude Haiku 4.5 – billigast tillgängliga
// modell, vald för att hålla kostnaden minimal). Jämför husets mätvärden mot
// kriterierna och skriver 2–3 meningar på svenska om vad som är bra och vad
// som är den svaga länken. Rent tillägg: saknas nyckel eller går anropet fel
// skickas ingen bedömning – det avgör aldrig Träff eller poäng.
const MODEL = "claude-haiku-4-5";

export function harAnthropicNyckel() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function skrivBedomning({ adress, typ, fakta, pris, k, pendling, omgivning, poang, prisJmforelse }) {
  if (!harAnthropicNyckel()) return null;

  const budgetKrav = [
    k.maxPris ? `maxpris ${k.maxPris.toLocaleString("sv-SE")} kr` : "",
    k.minRum ? `minst ${k.minRum} rum` : "",
    k.minBoarea ? `minst ${k.minBoarea} m² boarea` : "",
    k.minTomtarea ? `minst ${k.minTomtarea} m² tomt` : "",
  ].filter(Boolean).join(", ");

  const prisrad = prisJmforelse
    ? `Prisläge: ${prisJmforelse.husKvm.toLocaleString("sv-SE")} kr/m², vilket är ` +
      `${Math.abs(prisJmforelse.diffProcent)}% ${prisJmforelse.diffProcent <= 0 ? "under" : "över"} ` +
      `snittpriset (${prisJmforelse.snittKvm.toLocaleString("sv-SE")} kr/m²) för nyligen sålda ` +
      `jämförbara hus i området (baserat på ${prisJmforelse.antalJamforelser} sålda hus).`
    : "";

  const prompt = [
    `Hus: ${adress}${fakta ? ", " + fakta : ""}${pris ? `, pris ${pris.toLocaleString("sv-SE")} kr` : ""}.`,
    pendling.length ? `Pendling: ${pendling.join(" · ")}.` : "",
    omgivning.length ? `Omgivning: ${omgivning.join(" · ")}.` : "",
    prisrad,
    poang != null ? `Matchningspoäng: ${poang}/100.` : "",
    `Krav att bedöma mot: max hållplatsavstånd ${k.maxAvståndHållplatsM} m, ` +
      `max vattenavstånd ${k.maxAvståndVattenM} m, max skogsavstånd ${k.maxAvståndSkogM} m, ` +
      `naturkrav "${k.kravNatur ?? "något"}", max grannar inom 300 m: ${k.maxGrannarInom300m}` +
      (k.maxRestidStockholmMin ? `, max restid Stockholm C ${k.maxRestidStockholmMin} min` : "") +
      (budgetKrav ? `, ${budgetKrav}` : "") + ".",
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
          "utifrån pendling, natur, avskildhet och – när det finns data om det – om priset är bra jämfört med " +
          "nyligen sålda hus i området. Skriv EXAKT 2-3 meningar på svenska: vad som är bra, vad som är den " +
          "svaga länken (om någon), och en ärlig helhetsbild. Nämn prisläget bara om prisdata finns i " +
          "meddelandet. Var konkret och kortfattad – ingen hälsning, ingen rubrik, inga punktlistor.",
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
