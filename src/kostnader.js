// Alla kostnader för ett hus, engångs och löpande, uträknade ur det som är
// känt om just det huset. Till skillnad från ekonomi.js (har vi råd?) kräver
// det här ingen ifylld hushållsekonomi: lagfart, pantbrev, fastighetsavgift
// och ränta går att räkna på priset ensamt, och det är just de siffrorna en
// köpare behöver framför sig innan första samtalet med mäklaren.
//
// Varje rad säger själv om siffran är lagstadgad, hämtad ur husets egna
// uppgifter eller en uppskattning. En uppskattning som ser ut som ett faktum
// är värre än ingen siffra alls.
//
// Uppgifterna (pantbrev, taxeringsvärde, driftkostnad med mera) kommer ur
// data/husuppgifter.json, som fylls när en objektbeskrivning klistras in i
// ett mejl till inkorgen (se objektsida.js) eller när filen redigeras för
// hand. Saknas en uppgift räknas det försiktiga fallet, och fragor.js gör en
// fråga till mäklaren av luckan.
//
// LAGSTADGADE, hämtade 2026-10-18:
//   Fastighetsavgift småhus 2026: 0,75 % av taxeringsvärdet, högst 10 425 kr
//   per år. Hus med värdeår 2012 eller senare är avgiftsfria i 15 år.
//   Ränteavdrag: 30 % av räntan upp till 100 000 kr per år.
//   Källa: skatteverket.se. Lagfart och pantbrev: se ekonomi.js.
import {
  beraknaLagfart, beraknaPantbrev, amorteringsprocent, LAGFART, PANTBREV,
  DRIFTSKOSTNAD_KVM_AR_DEFAULT, RANTA_DEFAULT,
} from "./ekonomi.js";

export const FASTIGHETSAVGIFT = { procent: 0.75, takKrAr: 10425, ar: 2026, avgiftsfriFranVardear: 2012, avgiftsfriAr: 15 };
export const RANTEAVDRAG = { procent: 30, takRantaAr: 100000 };
/** Bolånetaket: högst 90 % belåning sedan 2026-04-01, alltså minst 10 % kontant. */
export const KONTANTINSATS_MIN_PROCENT = 10;
/** Uppskattning, inget regelverk. Vanliga råd landar mellan 100 och 200 kr
 *  per m² och år för en villa; mitten används och kan bytas i config under
 *  hushall.antagande.underhallKvmAr. */
export const UNDERHALL_KVM_AR_DEFAULT = 150;

const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
const procent = (n) => `${String(Math.round(n * 10) / 10).replace(".", ",")} %`;

export function fastighetsavgiftAr({ taxeringsvarde, byggar, iAr = new Date().getFullYear() }) {
  const F = FASTIGHETSAVGIFT;
  if (byggar != null && byggar >= F.avgiftsfriFranVardear && iAr < byggar + F.avgiftsfriAr) {
    return { kr: 0, kalla: "avgiftsfri", friTill: byggar + F.avgiftsfriAr };
  }
  if (taxeringsvarde != null) {
    return { kr: Math.min(Math.round(taxeringsvarde * (F.procent / 100)), F.takKrAr), kalla: "taxeringsvarde" };
  }
  // Taket är det försiktiga svaret: de flesta villor i Stockholms län har ett
  // taxeringsvärde över de 1,39 mkr där taket nås.
  return { kr: F.takKrAr, kalla: "tak" };
}

/** Pantbrev som redan finns följer med fastigheten, så bara mellanskillnaden
 *  mot lånet behöver tas ut. Okänt antal räknas som inga alls (det dyraste
 *  fallet), samma försiktighet som i ekonomi.js. */
export function pantbrevBehov({ lan, befintliga }) {
  const kand = befintliga != null;
  const nytt = Math.max(0, lan - (befintliga ?? 0));
  return { kand, befintliga: befintliga ?? null, nytt, kostnad: beraknaPantbrev(nytt) };
}

/**
 * hus: den sparade posten ur traffar.json. uppgifter: husets rad ur
 * husuppgifter.json (eller {}). hushall: config.hushall (får vara null).
 * Returnerar null när priset saknas, för utan pris finns inget att räkna på.
 */
export function kostnadsbild(hus, uppgifter = {}, hushall = null) {
  const pris = hus.pris;
  if (!pris) return null;
  const antagande = hushall?.antagande ?? {};
  const ranta = antagande.ranta ?? RANTA_DEFAULT;
  const underhallKvmAr = antagande.underhallKvmAr ?? UNDERHALL_KVM_AR_DEFAULT;
  const driftSchablon = antagande.driftskostnadKvmAr ?? DRIFTSKOSTNAD_KVM_AR_DEFAULT;
  const boarea = hus.boarea ?? null;
  const byggar = uppgifter.byggar ?? hus.byggar ?? null;

  const minKontant = Math.ceil(pris * (KONTANTINSATS_MIN_PROCENT / 100));
  const egenKontant = typeof hushall?.kontantinsatsTillgangligt === "number" ? hushall.kontantinsatsTillgangligt : null;
  const kontantinsats = Math.min(pris, Math.max(minKontant, egenKontant ?? 0));
  const lan = pris - kontantinsats;
  const belaning = lan / pris;
  const amProcent = amorteringsprocent(belaning);

  const lagfart = beraknaLagfart(pris);
  const pantbrev = pantbrevBehov({ lan, befintliga: uppgifter.pantbrev ?? null });

  // Driftkostnad: husets egna uppgifter, sedan mäklarens kalkyl, sedan
  // Boolis siffra (sparad i ekonomi.drift), sist schablonen.
  const kandDrift = uppgifter.driftskostnadManad
    ?? hus.maklarkalkyl?.driftkostnadManad
    ?? (hus.ekonomi?.drift?.kalla === "annons" ? hus.ekonomi.drift.kr : null);
  const drift = kandDrift != null
    ? { kr: kandDrift, kalla: "kand" }
    : boarea ? { kr: Math.round((boarea * driftSchablon) / 12), kalla: "schablon" } : null;

  const avgift = fastighetsavgiftAr({ taxeringsvarde: uppgifter.taxeringsvarde ?? null, byggar });
  const rantaManad = Math.round((lan * (ranta / 100)) / 12);
  const amorteringManad = Math.round((lan * (amProcent / 100)) / 12);
  const ranteavdragManad = Math.round(
    (Math.min(rantaManad * 12, RANTEAVDRAG.takRantaAr) * (RANTEAVDRAG.procent / 100)) / 12
  );
  const underhallManad = boarea ? Math.round((boarea * underhallKvmAr) / 12) : null;
  const tomtrattManad = uppgifter.tomtrattsavgaldAr ? Math.round(uppgifter.tomtrattsavgaldAr / 12) : null;
  const samfallighetManad = uppgifter.samfallighetAr ? Math.round(uppgifter.samfallighetAr / 12) : null;

  const manadTotal = rantaManad + amorteringManad + (drift?.kr ?? 0) + Math.round(avgift.kr / 12)
    + (underhallManad ?? 0) + (tomtrattManad ?? 0) + (samfallighetManad ?? 0);

  return {
    pris, kontantinsats, minKontant, egenKontant, lan, belaningProcent: belaning * 100, amProcent, ranta,
    lagfart, pantbrev, kontantVidKop: kontantinsats + lagfart.total + pantbrev.kostnad.total,
    manad: {
      ranta: rantaManad, amortering: amorteringManad, drift, fastighetsavgift: avgift,
      underhall: underhallManad, underhallKvmAr, tomtratt: tomtrattManad, samfallighet: samfallighetManad,
      total: manadTotal, ranteavdrag: ranteavdragManad, driftSchablon,
    },
  };
}

/** Kostnadsbilden som två rubricerade radgrupper i samma {titel, rader}-form
 *  som index.js sektioner. Raderna hålls under 120 tecken, för längre text
 *  ritar Alva som fritext med AI-ikon, och inga rader börjar med ✓ eller ⚠
 *  (det är Alvas tecken för en slutsats, inte en kostnad). */
export function kostnadsSektioner(k) {
  if (!k) return [];
  const pb = k.pantbrev;
  const pantbrevRad = !pb.kand
    ? `Pantbrev: upp till ${kr(pb.kostnad.total)} om inga pantbrev finns (2 % av lånet + ${PANTBREV.expedition} kr)`
    : pb.nytt === 0
      ? `Pantbrev: 0 kr, befintliga pantbrev på ${kr(pb.befintliga)} täcker lånet`
      : `Pantbrev: ${kr(pb.kostnad.total)} för nya pantbrev på ${kr(pb.nytt)} (${kr(pb.befintliga)} finns redan)`;

  const kontantRad = k.egenKontant != null && k.egenKontant >= k.minKontant
    ? `Kontantinsats: ${kr(k.kontantinsats)} (er egen, ${procent((k.kontantinsats / k.pris) * 100)})`
    : k.egenKontant != null
      ? `Kontantinsats: ${kr(k.minKontant)} krävs (minst 10 %), ni har angett ${kr(k.egenKontant)}`
      : `Kontantinsats: minst ${kr(k.minKontant)} (10 % av priset)`;

  const engang = [
    `Lagfart: ${kr(k.lagfart.total)} (1,5 % av utgångspriset + ${LAGFART.expedition} kr)`,
    pantbrevRad,
    kontantRad,
    `Att betala vid köpet: ca ${kr(k.kontantVidKop)} (kontantinsats, lagfart och pantbrev)`,
    "Varje 100 000 kr över utgångspriset: +1 500 kr lagfart och upp till +2 000 kr pantbrev",
    "Räkna även med överlåtelsebesiktning, ca 10 000 till 15 000 kr, och flytt",
  ];

  const m = k.manad;
  const avgiftRad = m.fastighetsavgift.kalla === "avgiftsfri"
    ? `Fastighetsavgift: 0 kr, nybyggt hus är avgiftsfritt till ${m.fastighetsavgift.friTill}`
    : m.fastighetsavgift.kalla === "taxeringsvarde"
      ? `Fastighetsavgift: ${kr(m.fastighetsavgift.kr / 12)}/mån (0,75 % av taxeringsvärdet)`
      : `Fastighetsavgift: högst ${kr(m.fastighetsavgift.kr / 12)}/mån (taket ${kr(FASTIGHETSAVGIFT.takKrAr)}/år, taxeringsvärdet okänt)`;
  const lopande = [
    `Ränta: ${kr(m.ranta)}/mån (lån ${kr(k.lan)} till antagna ${procent(k.ranta)})`,
    `Amortering: ${kr(m.amortering)}/mån (${k.amProcent} % per år vid ${procent(k.belaningProcent)} belåning)`,
    m.drift && (m.drift.kalla === "kand"
      ? `Driftkostnad: ${kr(m.drift.kr)}/mån enligt husets uppgifter`
      : `Driftkostnad: ca ${kr(m.drift.kr)}/mån (schablon ${m.driftSchablon} kr/m² och år, verklig siffra saknas)`),
    avgiftRad,
    m.tomtratt != null && `Tomträttsavgäld: ${kr(m.tomtratt)}/mån`,
    m.samfallighet != null && `Samfällighet och vägförening: ${kr(m.samfallighet)}/mån`,
    m.underhall != null && `Underhåll att spara till: ca ${kr(m.underhall)}/mån (uppskattat ${m.underhallKvmAr} kr/m² och år)`,
    `Totalt: ca ${kr(m.total)}/mån, ca ${kr(m.total - m.ranteavdrag)} efter ränteavdraget på 30 %`,
  ].filter(Boolean);

  return [
    { titel: "KÖPKOSTNADER", rader: engang },
    { titel: "LÖPANDE KOSTNADER", rader: lopande },
  ];
}
