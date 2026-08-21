// Hämtar driftskostnad och byggår direkt från Boolis annonssida – fält
// bevakningsmejlen aldrig innehåller, men som avgör hela kostnadsbilden i
// ekonomi.js. Bara Booli: Hemnets robots.txt ligger bakom en Cloudflare-
// utmaning (även robots.txt själv svarar med en JS-captcha), vilket är aktiv
// bot-blockering, inte bara ett villkor i finstilt – och att kringgå den vore
// exakt den sortens spel mot ett skydd som appen aldrig annars ägnar sig åt.
// Boolis robots.txt tillåter uttryckligen annonssidorna.
//
// Fungerar för alla hus med ett booli.se-id, oavsett om det kom via Boolis
// eget API eller via ett bevakningsmejl (båda ger en booli-XXXX-adress).
// Hemnet-hus får ingen berikning – driftskostnad/byggår blir null, precis
// som andra kända luckor i appen (jämför "avgift okänd" i bil.js): en
// ärlig lucka, inte en gissning.
const TIMEOUT_MS = 10_000;

export function arBooliAnnons(annons) {
  return typeof annons?.id === "string" && annons.id.startsWith("booli-") && /booli\.se/.test(annons?.url ?? "");
}

/**
 * Boolis annonssida bäddar in strukturerad data i en __NEXT_DATA__-script-
 * tagg som `{"key":"constructionYear","label":"Byggår","value":{"plainText":
 * "1962"}}` och `{"key":"operatingCost",...,"markdown":"Driftskostnaden är
 * **5 872** kr/mån"}`. Regex mot den rå HTML:en är mer motståndskraftigt mot
 * ombyggda sidlayouter än att följa Next.js interna prop-sökväg, som kan
 * ändras vid nästa deploy – nyckelnamnen är knutna till Boolis GraphQL-schema,
 * inte sidans utseende.
 */
export function tolkaBooliannons(html) {
  const byggarM = html.match(/"key":"constructionYear"[^}]*?"plainText":"(\d{4})"/);
  const byggar = byggarM ? Number(byggarM[1]) : null;

  const driftM = html.match(/"key":"operatingCost"[^}]*?markdown":"Driftskostnaden är \*\*([\d\s]+)\*\* kr\/(mån|år)"/);
  let driftskostnadManad = null;
  if (driftM) {
    const belopp = Number(driftM[1].replace(/\s/g, ""));
    driftskostnadManad = driftM[2] === "år" ? Math.round(belopp / 12) : belopp;
  }

  return { byggar, driftskostnadManad };
}

/** Never kastar – ett fel eller en oväntad sidlayout ska bara lämna
 * fälten null, aldrig avbryta körningen för de andra husen. */
export async function berikaFranBooli(annons) {
  if (!arBooliAnnons(annons)) return { byggar: null, driftskostnadManad: null };
  try {
    const res = await fetch(annons.url, {
      headers: {
        "User-Agent": "Bostadsvakt-bot/1.0 (+github.com/matthewholm/bostadsvakt)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`  Kunde inte hämta annonssidan (${res.status}) för ${annons.id} – hoppar över berikning.`);
      return { byggar: null, driftskostnadManad: null };
    }
    return tolkaBooliannons(await res.text());
  } catch (err) {
    console.warn(`  Kunde inte hämta annonssidan för ${annons.id}: ${err.message}`);
    return { byggar: null, driftskostnadManad: null };
  }
}
