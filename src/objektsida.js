// Läser husets egna uppgifter (pantbrev, taxeringsvärde, driftkostnad,
// byggår, uppvärmning, vatten och avlopp med mera) ur en inklistrad
// objektbeskrivning. Hemnet visar en del av dem, mäklarens egen
// objektbeskrivning resten, och båda ligger bakom sidor appen inte hämtar
// själv. Vägen in är därför samma som för söksidorna (se mailsource.js):
// markera allt på sidan, klistra in i ett mejl till inkorgen. Det går lika
// bra att skriva mejlet för hand ("Häckgränd 8, pantbrev 1 200 000 kr").
//
// Etiketterna känns igen på sina ord, inte på sidans uppmärkning, så samma
// tolk klarar Hemnet, mäklarsidor och handskrivna mejl. Etikett och värde
// får stå på samma rad eller på var sin, som de hamnar när en sida kopieras.

const BELOPP = String.raw`(\d{1,3}(?: \d{3})+|\d{4,})`;
const SMABELOPP = String.raw`(\d{1,3}(?: \d{3})*)`;
const SEP = String.raw`[ \t:]*\n?[ \t]*`;

const tal = (s) => Number(String(s).replace(/\s/g, ""));
const forsta = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function normaliseraText(text) {
  return String(text ?? "")
    .replace(/[   ]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function htmlTillText(html) {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d|dt|dd|td|th|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&sup2;|&#178;/gi, "²")
    .replace(/&aring;/g, "å").replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö")
    .replace(/&Aring;/g, "Å").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö");
}

/** Värdet efter en etikett, fram till radslut. */
function textEfter(text, etikett) {
  // Etiketten måste vara ett helt ord, annars hittar "VA" sitt värde inne i
  // "(varav byggnad ...)".
  const m = text.match(new RegExp(`(?:^|\\n|[^\\p{L}])(?:${etikett})(?!\\p{L})${SEP}([^\\n]{2,80})`, "iu"));
  return m ? m[1].trim().replace(/[.,;]+$/, "") : null;
}

/**
 * Pantbrev står i två sorters sammanhang som måste hållas isär: de som redan
 * finns ("Pantbrev: 6 st, totalt 2 340 000 kr") och mäklarkalkylens kostnad
 * för nya ("Pantbrev 43 291 kr"). Ett antal, eller ord som totalt/uttagna/
 * befintliga/inteckning, gör det till befintliga pantbrev. Utan sådana ord
 * räknas bara belopp över 150 000 kr, för en pantbrevskostnad når sällan dit.
 */
export function tolkaPantbrev(text) {
  if (/(inga|saknar)\s+pantbrev|pantbrev[ \t:]*\n?[ \t]*(inga|saknas)\b/i.test(text)) return { pantbrev: 0, pantbrevAntal: 0 };
  const re = /pantbrev|inteckning/gi;
  for (const m of text.matchAll(re)) {
    const fore = text.slice(Math.max(0, m.index - 30), m.index);
    const efter = text.slice(m.index, m.index + 140);
    if (/kostnad|avgift|nya pantbrev|uttag av nya|stämpelskatt/i.test(efter.slice(0, 40)) || /kostnad för|nya\s*$/i.test(fore)) continue;
    const belopp = efter.match(new RegExp(`${BELOPP}\\s*(?:kr|:-|SEK)`));
    if (!belopp) continue;
    const n = tal(belopp[1]);
    const antal = (efter.match(/(\d{1,2})\s*st\b/) ?? fore.match(/(\d{1,2})\s*(?:st\.?\s*)?(?:pantbrev|inteckningar)\s*$/i))?.[1];
    const tydlig = antal != null || /totalt|sammanlagt|uttagna|befintliga|inteckning|\bom\b/i.test(efter);
    if (n >= 10000 && (tydlig || n >= 150000)) {
      return { pantbrev: n, pantbrevAntal: antal != null ? Number(antal) : null };
    }
  }
  return {};
}

export function tolkaObjektsida(rå) {
  const text = normaliseraText(rå);
  const u = {};

  Object.assign(u, tolkaPantbrev(text));

  // Priset: med etikett hos mäklaren ("Utgångspris 2 495 000 kr"), utan hos
  // Hemnet, där det står ensamt på en rad under adressen. Den första sådana
  // raden är husets eget pris; liknande bostäder kommer längre ner.
  const prisEtikett = text.match(new RegExp(`(?:utgångspris|begärt pris|accepterat pris|^pris)${SEP}${BELOPP}\\s*kr\\b(?!\\s*\\/)`, "im"));
  const prisRad = text.match(new RegExp(`^${BELOPP}\\s*kr[ \\t]*$`, "m"));
  const pris = prisEtikett ?? prisRad;
  if (pris && tal(pris[1]) >= 300000) u.pris = tal(pris[1]);

  const tax = text.match(new RegExp(`taxeringsvärde(?:\\s*(?:år\\s*)?(?:19|20)\\d\\d)?${SEP}(?:totalt\\s*)?${BELOPP}\\s*kr`, "i"));
  if (tax && tal(tax[1]) >= 100000) u.taxeringsvarde = tal(tax[1]);

  const drift = text.match(new RegExp(`drifts?kostnad(?:er)?(?:\\s*per\\s*(?:år|månad))?${SEP}(?:ca\\.?\\s*)?${BELOPP}\\s*kr(?:\\s*(?:\\/|per)\\s*(år|mån|månad))?`, "i"));
  if (drift) {
    const n = tal(drift[1]);
    const perAr = drift[2] ? drift[2] === "år" : n >= 15000;
    u.driftskostnadManad = perAr ? Math.round(n / 12) : n;
  }

  const bygg = text.match(new RegExp(`byggår${SEP}(?:ca\\.?\\s*)?((?:17|18|19|20)\\d\\d)`, "i"));
  if (bygg) u.byggar = Number(bygg[1]);

  const form = text.match(new RegExp(`upplåtelseform${SEP}(äganderätt|tomträtt|friköpt|bostadsrätt)`, "i"));
  if (form) u.upplatelseform = /friköpt/i.test(form[1]) ? "Äganderätt" : forsta(form[1].toLowerCase());

  const avgald = text.match(new RegExp(`tomträttsavgäld${SEP}(?:ca\\.?\\s*)?${SMABELOPP}\\s*kr(?:\\s*(?:\\/|per)\\s*(år|mån|månad))?`, "i"));
  if (avgald) {
    const n = tal(avgald[1]);
    u.tomtrattsavgaldAr = avgald[2] && avgald[2] !== "år" ? n * 12 : n;
    u.upplatelseform ??= "Tomträtt";
  }

  const samf = text.match(new RegExp(`(?:samfällighet\\w*|vägförening\\w*|gemensamhetsanläggning\\w*)[^\\n]{0,80}?${SMABELOPP}\\s*kr(?:\\s*(?:\\/|per)\\s*(år|mån|månad))?`, "i"));
  if (samf) {
    const n = tal(samf[1]);
    u.samfallighetAr = samf[2] && samf[2] !== "år" ? n * 12 : n;
  } else if (/(ingen|inte (?:med )?i någon) (samfällighet|vägförening)|samfällighet${SEP}(nej|ingen)\b/i.test(text)) {
    u.ingenSamfallighet = true;
  }

  const varme = textEfter(text, "uppvärmning|värmesystem|uppvärmningssätt");
  if (varme) u.uppvarmning = forsta(varme.slice(0, 60));

  const va = textEfter(text, "vatten och avlopp|vatten & avlopp|vatten\\/avlopp|VA");
  const avlopp = textEfter(text, "avlopp");
  const vatten = textEfter(text, "vatten");
  if (va) u.va = forsta(va.slice(0, 60));
  else if (avlopp || vatten) u.va = [vatten && `vatten ${vatten.toLowerCase()}`, avlopp && `avlopp ${avlopp.toLowerCase()}`].filter(Boolean).map(forsta).join(", ").slice(0, 80);

  const energi = text.match(new RegExp(`energiklass${SEP}([A-G])\\b`, "i"));
  if (energi) u.energiklass = energi[1].toUpperCase();

  const beteckning = textEfter(text, "fastighetsbeteckning");
  if (beteckning) u.fastighetsbeteckning = beteckning.slice(0, 50);

  return u;
}

const normAdress = (s) => (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();

/**
 * Vilket känt hus texten handlar om. Ämnesraden går först, sedan texten,
 * och den adress som står tidigast vinner: en kopierad Hemnet-sida har sin
 * egen adress som rubrik och andra hus ("Liknande bostäder") längre ner.
 * Två olika hus på samma tidigaste plats är för osäkert och ger null.
 */
export function hittaHus(text, amne, husLista) {
  for (const kalla of [amne, text]) {
    const t = normAdress(normaliseraText(kalla));
    if (!t) continue;
    let bast = null;
    for (const hus of husLista) {
      const adr = normAdress(hus.adress);
      if (adr.length < 6) continue;
      const re = new RegExp(`(?:^|[^\\p{L}\\d])${adr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "u");
      const m = t.match(re);
      if (!m) continue;
      const pos = m.index;
      if (!bast || pos < bast.pos || (pos === bast.pos && adr.length > bast.len)) bast = { hus, pos, len: adr.length, delad: false };
      else if (pos === bast.pos && adr.length === bast.len && hus.id !== bast.hus.id) bast.delad = true;
    }
    if (bast) return bast.delad ? null : bast.hus;
  }
  return null;
}
