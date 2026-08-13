// Kort AI-skriven bedömning per hus (Claude Haiku 4.5 – billigast tillgängliga
// modell, vald för att hålla kostnaden minimal). Jämför husets mätvärden mot
// kriterierna och skriver 2–3 meningar på svenska om vad som är bra och vad
// som är den svaga länken. Rent tillägg: saknas nyckel eller går anropet fel
// skickas ingen bedömning – det avgör aldrig Träff eller poäng.
const MODEL = "claude-haiku-4-5";

export function harAnthropicNyckel() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function skrivBedomning({
  adress, typ, fakta, pris, k, pendling, omgivning, poang, prisJmforelse,
  kommun, myndighet, matchning, turtathet,
}) {
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

  // Läget är det viktigaste kontextet: en modell som bara ser "Norrtälje" i
  // en adress gissar gärna fel om trafikbolag och biljetter. Här får den
  // kommunen, länet och vilket bolag som faktiskt trafikerar området, och
  // instrueras nedan att aldrig hitta på något utöver det.
  const lagesrad = kommun
    ? `Läge: ${kommun} kommun${myndighet ? `, ${myndighet.lan}, trafikeras av ${myndighet.namn}` : ""}.`
    : "";

  const turrad = turtathet
    ? `Turtäthet från närmaste hållplats: ${turtathet.text}` +
      (turtathet.forsta ? ` (första ${turtathet.forsta}, sista ${turtathet.sista})` : "") +
      (turtathet.kraverBokning ? ". OBS: trafiken här är anropsstyrd och måste bokas i förväg." : ".")
    : "";

  const poangrad = matchning?.delar?.length
    ? `Matchningspoäng ${poang}/100, uppdelat: ` +
      matchning.delar.map((d) => `${d.namn} ${d.delpoang}/100 (väger ${Math.round(d.andelProcent)} %)`).join(", ") + "."
    : poang != null ? `Matchningspoäng: ${poang}/100.` : "";

  const prompt = [
    `Hus: ${adress}${fakta ? ", " + fakta : ""}${pris ? `, pris ${pris.toLocaleString("sv-SE")} kr` : ""}.`,
    lagesrad,
    pendling.length ? `Pendling: ${pendling.join(" · ")}.` : "",
    turrad,
    omgivning.length ? `Omgivning: ${omgivning.join(" · ")}.` : "",
    prisrad,
    poangrad,
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
          "meddelandet. Var konkret och kortfattad – ingen hälsning, ingen rubrik, inga punktlistor. Du får " +
          "aldrig ställa följdfrågor eller be om mer information – meddelandet är allt du får, det finns ingen " +
          "mottagare som kan svara dig. Räcker informationen inte för en bedömning, säg det i en kort mening " +
          "istället för att bedöma.\n\n" +
          "VIKTIGT om kollektivtrafik och biljetter: skriv ALDRIG något om trafikbolag, biljetter eller " +
          "zoner som inte redan står ordagrant i meddelandet. Gissa aldrig utifrån ortsnamnet. Norrtälje " +
          "kommun ligger i Stockholms län och trafikeras av SL – inte UL. Uppsala län trafikeras av UL. " +
          "Påstå bara att det krävs två biljetter om meddelandet uttryckligen säger att resan korsar en " +
          "länsgräns. Står det att trafiken är anropsstyrd och måste bokas i förväg är det en viktig " +
          "nackdel som bör nämnas.\n" +
          "Om en uppdelning av matchningspoängen finns med: förklara kort vad som drar upp respektive ner " +
          "poängen, istället för att bara upprepa siffran.",
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
