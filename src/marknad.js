// Prisbedömning och budförslag per hus, byggt på SCB:s öppna statistik över
// sålda villor (permanentbostad, ej tomträtt) i husets kommun.
//
// Det bärande talet är köpeskillingskoefficienten (K/T): slutpriset delat
// med taxeringsvärdet, i snitt för alla villor som såldes i kommunen. Med
// husets eget taxeringsvärde ger den en uppskattning av marknadsvärdet som
// tar hänsyn till storlek, läge och tomt, eftersom taxeringsvärdet redan gör
// det. Kommunens K/T kommer från helårsstatistiken och justeras med länets
// senaste tremånaderstal, så att uppskattningen följer marknaden fram till
// förra månaden och inte står still på förra årets nivå.
//
// Utan taxeringsvärde finns inget husspecifikt att räkna på. Då visas
// kommunens snittpris som en grov ram och vilket taxeringsvärde utgångspriset
// motsvarar, så att svaret från mäklaren genast går att tolka.
//
// Källa: SCB, tabellerna BO0501B/FastprisSHRegionAr och BO0501B/SmahusT2M,
// via deras öppna PxWeb-API. Siffrorna cachas i data/marknad.json en vecka.
import { readFileSync, writeFileSync } from "node:fs";

const SCB = "https://api.scb.se/OV0104/v1/doris/sv/ssd/BO/BO0501/BO0501B";
const CACHE_DAGAR = 7;
/** Hur långt ett enskilt hus brukar ligga från kommunens snitt-K/T. Ett
 *  försiktigt spann snarare än ett exakt tal, för skick och renovering syns
 *  inte i taxeringsvärdet. */
export const SPANN_PROCENT = 8;
const TIMEOUT_MS = 15_000;

const normNamn = (s) => (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+kommun$/, "").trim();

async function scb(tabell, query) {
  const res = await fetch(`${SCB}/${tabell}`, {
    method: query ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: query ? JSON.stringify({ query, response: { format: "json" } }) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SCB svarade ${res.status} för ${tabell}`);
  return res.json();
}

/** Hämtar kommun- och länssiffror för de kommuner och län som husen ligger
 *  i. Kastar vid nätfel; anroparen faller då tillbaka på cachen. */
export async function hamtaFranScb(kommuner, lan) {
  const meta = await scb("FastprisSHRegionAr");
  const region = meta.variables.find((v) => v.code === "Region");
  const ar = meta.variables.find((v) => v.code === "Tid").values.at(-1);
  const kodFor = (namn) => {
    const i = region.valueTexts.findIndex((t) => normNamn(t) === normNamn(namn));
    return i === -1 ? null : region.values[i];
  };
  const kommunKoder = Object.fromEntries(kommuner.map((k) => [k, kodFor(k)]).filter(([, kod]) => kod));
  const lanKoder = Object.fromEntries(lan.map((l) => [l, kodFor(l)]).filter(([, kod]) => kod));
  const allaKoder = [...Object.values(kommunKoder), ...Object.values(lanKoder)];
  if (!allaKoder.length) return { hamtad: new Date().toISOString(), ar, kommuner: {}, lan: {} };

  const arsdata = await scb("FastprisSHRegionAr", [
    { code: "Region", selection: { filter: "item", values: allaKoder } },
    { code: "Fastighetstyp", selection: { filter: "item", values: ["220"] } },
    { code: "Tid", selection: { filter: "item", values: [ar] } },
  ]);
  const perKod = new Map(arsdata.data.map((r) => {
    const [antal, medelprisTkr, taxTkr, kt] = r.values.map(Number);
    return [r.key[0], { antal, medelprisTkr, taxTkr, kt }];
  }));

  const manadsdata = Object.keys(lanKoder).length
    ? await scb("SmahusT2M", [
        { code: "Region", selection: { filter: "item", values: Object.values(lanKoder) } },
        { code: "ContentsCode", selection: { filter: "item", values: ["BO0501AK"] } },
        { code: "Tid", selection: { filter: "top", values: ["1"] } },
      ])
    : { data: [] };
  const senasteKt = new Map(manadsdata.data.map((r) => [r.key[0], { manad: r.key[1], kt: Number(r.values[0]) }]));

  const ut = { hamtad: new Date().toISOString(), ar, kommuner: {}, lan: {} };
  for (const [namn, kod] of Object.entries(kommunKoder)) if (perKod.has(kod)) ut.kommuner[namn] = { kod, ...perKod.get(kod) };
  for (const [namn, kod] of Object.entries(lanKoder)) {
    if (!perKod.has(kod)) continue;
    ut.lan[namn] = { kod, ktAr: perKod.get(kod).kt, ...(senasteKt.get(kod) ?? {}) };
  }
  return ut;
}

/** Läser cachen, hämtar nytt om den är äldre än en vecka eller saknar någon
 *  kommun, och skriver tillbaka. Ett nätfel ger cachen som den är (eller
 *  null), aldrig ett avbrott: prisbedömningen är ett tillägg, inte en del
 *  av själva bevakningen. */
export async function lasMarknad(fil, kommuner, lan) {
  let cache = null;
  try { cache = JSON.parse(readFileSync(fil, "utf8")); } catch {}
  const farsk = cache && Date.now() - new Date(cache.hamtad).getTime() < CACHE_DAGAR * 86400000;
  const komplett = cache && kommuner.every((k) => cache.kommuner?.[k]) && lan.every((l) => cache.lan?.[l]);
  if (farsk && komplett) return cache;
  try {
    const ny = await hamtaFranScb(kommuner, lan);
    writeFileSync(fil, JSON.stringify(ny, null, 2) + "\n");
    return ny;
  } catch (err) {
    console.warn(`Kunde inte hämta prisstatistik från SCB: ${err.message}`);
    return cache;
  }
}

const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
const mkr = (n) => `${(n / 1000000).toFixed(1).replace(".", ",")} mkr`;
const avrunda = (n, steg = 25000) => Math.round(n / steg) * steg;
const decimal = (n, d = 2) => n.toFixed(d).replace(".", ",");

/** Kommunens K/T framräknat till idag: helårstalet gånger länets förändring
 *  sedan dess. */
export function aktuelltKt(marknad, kommun, lan) {
  const k = marknad?.kommuner?.[kommun];
  if (!k?.kt) return null;
  const l = marknad?.lan?.[lan];
  const faktor = l?.kt && l?.ktAr ? l.kt / l.ktAr : 1;
  return { kt: k.kt * faktor, ktAr: k.kt, ar: marknad.ar, manad: l?.manad ?? null, justerad: faktor !== 1 };
}

/**
 * hus: posten ur traffar.json. uppgifter: husuppgifter.json-raden.
 * kostnad: kostnadsbild() ur kostnader.js (för vad ett högre bud kostar).
 * flode: alla hus i flödet (för utgångspriser per m² i samma kommun).
 * maxPris: hushållets övre gräns ur kriterierna, eller null.
 */
export function prisbedomning({ hus, uppgifter = {}, marknad, kostnad, flode = [], maxPris = null }) {
  const pris = hus.pris;
  if (!pris) return null;
  const kt = aktuelltKt(marknad, hus.kommun, hus.lan);
  const kommunData = marknad?.kommuner?.[hus.kommun];
  const tax = uppgifter.taxeringsvarde ?? null;
  const rader = [];

  // Uppskattat värde: taxeringsvärde × K/T i första hand, sålda hus per m²
  // (slutpriser.js) i andra. Inget av dem: inget värde, hellre än en gissning.
  let varde = null;
  if (tax && kt) {
    varde = tax * kt.kt;
    rader.push(`Uppskattat marknadsvärde: ca ${mkr(varde)} (${mkr(varde * (1 - SPANN_PROCENT / 100))} till ${mkr(varde * (1 + SPANN_PROCENT / 100))})`);
    rader.push(`Taxeringsvärdet ${kr(tax)} × ${decimal(kt.kt)}, K/T-talet för sålda villor i ${hus.kommun} (SCB)`);
  } else if (hus.prisJmforelse && hus.boarea) {
    varde = hus.prisJmforelse.snittKvm * hus.boarea;
    rader.push(`Uppskattat marknadsvärde: ca ${mkr(varde)} (${hus.boarea} m² × områdets ${kr(hus.prisJmforelse.snittKvm)}/m²)`);
  }

  if (varde) {
    const diff = Math.round(((pris - varde) / varde) * 100);
    rader.push(
      diff <= -5 ? `Utgångspriset ligger ${-diff} % under uppskattningen: räkna med budgivning över utgångspris`
      : diff >= 5 ? `Utgångspriset ligger ${diff} % över uppskattningen: det finns utrymme att bjuda under`
      : `Utgångspriset ligger i nivå med uppskattningen (${diff > 0 ? "+" : ""}${diff} %)`);
  } else if (kt) {
    rader.push(`Utgångspriset motsvarar ett taxeringsvärde på ca ${kr(avrunda(pris / kt.kt, 10000))}`);
    rader.push("Är husets verkliga taxeringsvärde högre än så är priset lågt satt, och tvärtom");
  }
  if (kommunData) {
    rader.push(`Snittpris för sålda villor i ${hus.kommun} ${marknad.ar}: ${mkr(kommunData.medelprisTkr * 1000)} (${kommunData.antal} sålda, SCB)`);
  }

  // Utgångspriser per m² i flödet: inte slutpriser, men samma kommun och
  // samma vecka, och därmed det säljarna själva tror just nu.
  if (hus.boarea && hus.kommun) {
    const andra = flode.filter((h) => h.id !== hus.id && h.kommun === hus.kommun && h.pris && h.boarea);
    if (andra.length >= 3) {
      const snitt = andra.reduce((s, h) => s + h.pris / h.boarea, 0) / andra.length;
      rader.push(`${kr(pris / hus.boarea)}/m², mot ${kr(snitt)}/m² för ${andra.length} andra hus till salu i ${hus.kommun}`);
    }
  }

  // Bud
  const startbud = varde && pris > varde * 1.05 ? avrunda(varde * 0.95) : pris;
  rader.push(startbud < pris
    ? `Förslag på första bud: ${kr(startbud)}, under utgångspriset`
    : `Förslag på första bud: utgångspriset, ${kr(pris)}`);
  if (varde) {
    const tak = maxPris ? Math.min(avrunda(varde), maxPris) : avrunda(varde);
    rader.push(`Förslag på smärtgräns: ${kr(Math.max(tak, startbud))}${maxPris && varde > maxPris ? ", er maxgräns, under uppskattat värde" : ", det uppskattade värdet"}`);
    if (maxPris && varde * (1 - SPANN_PROCENT / 100) > maxPris) {
      rader.push("Även nedre delen av uppskattningen ligger över er maxgräns: räkna med att andra bjuder högre");
    }
  } else {
    // Utan uppskattat värde vore varje smärtgräns en gissning, och er
    // maxgräns ur kriterierna säger inget om vad just det här huset är värt.
    rader.push("Smärtgräns: be mäklaren om taxeringsvärdet, så räknas ett förslag fram här");
  }
  if (kostnad) {
    const merLan = kostnad.egenKontant != null && kostnad.egenKontant >= kostnad.minKontant ? 100000 : 90000;
    const merManad = Math.round((merLan * ((kostnad.ranta + kostnad.amProcent) / 100)) / 12);
    rader.push(`Varje 100 000 kr i högre bud: ca ${kr(merManad)}/mån mer${merLan < 100000 ? " och 10 000 kr mer kontant" : ""}`);
  }
  if (hus.prisSankning) rader.push("Priset är redan sänkt en gång, så säljaren kan vara öppen för bud under utgångspriset");
  rader.push("Bestäm smärtgränsen före visningen och höj i små steg, till exempel 25 000 kr");

  return { varde, kt, rader };
}
