// Analyserar en enskild annons-länk (klistras in på klistra-in-sidan eller
// startas från Actions): tolkar adressen, mäter pendling/natur, granskar
// annonsens bilder och pushar resultatet – oavsett om huset uppfyller kraven
// eller inte, med tydlig lista på vad som brister.
//
// Annonsens sida kommer från ett av två håll. Har klistra-in-sidan lagt den
// som data/annons.html (inklistrad, eller skickad med bokmärket från
// mobilens webbläsare) används den. Annars hämtas den här, men bara från
// Booli: Hemnet ligger bakom en Cloudflare-utmaning mot robotar, och den
// kringgås inte (se annonsberikning.js). En Hemnet-länk utan inskickad sida
// analyseras därför som förut, på läget, och notisen säger hur bilderna
// kommer med.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tolkaHemnetSlug } from "./mailsource.js";
import { geokoda } from "./geocode.js";
import { narmasteHallplatser, resaTillStockholm, harResrobotNyckel } from "./transit.js";
import { naturInfo } from "./nature.js";
import { notis } from "./notify.js";
import { lasTraffar, sparaTraffar } from "./matches.js";
import { beraknaPoang } from "./score.js";
import { skrivBedomning } from "./ai.js";
import { lasSlutpriser, jamforPris } from "./slutpriser.js";
import { tolkaObjektsida, htmlTillText, normaliseraText, booliAdress, annonsenGaller } from "./objektsida.js";
import { kandaUppgifter } from "./fragor.js";
import { hittaBilder } from "./bilder.js";
import { granskaAnnonsbilder, bildgranskningNotis, harNyckel } from "./bildgranskning.js";

const config = JSON.parse(readFileSync(new URL("../data-repo/config.json", import.meta.url), "utf8"));
const k = config.kriterier;
const fmtTid = (min) => (min >= 60 ? `${Math.floor(min / 60)} tim ${min % 60} min` : `${min} min`);
const annonsFil = new URL("../data-repo/data/annons.html", import.meta.url);
const nyaUppgifterFil = new URL("../data-repo/data/husuppgifter-nya.json", import.meta.url);

const url = (process.env.ANNONS_URL ?? "").trim();
if (!url) {
  console.error("Ingen länk angiven (ANNONS_URL).");
  process.exit(1);
}

async function hamtaBooliSida(lank) {
  try {
    const res = await fetch(lank, {
      headers: { "User-Agent": "Bostadsvakt-bot/1.0 (+github.com/matthewholm/bostadsvakt)", Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return await res.text();
    console.warn(`Booli svarade ${res.status} för ${lank}.`);
  } catch (err) {
    console.warn(`Booli nåddes inte: ${err.message}`);
  }
  return null;
}

let sida = existsSync(annonsFil) ? readFileSync(annonsFil, "utf8") : null;
if (sida) {
  // En fil som blev kvar efter en körning som föll får inte följa med nästa,
  // annan länk.
  if (annonsenGaller(sida, url)) {
    console.log(`Annonsens sida skickades med (${Math.round(sida.length / 1024)} kB).`);
  } else {
    console.log("data/annons.html gäller en annan länk, används inte.");
    sida = null;
  }
}

const hemnetSlug = url.match(/hemnet\.se\/bostad\/([a-z0-9-]+)/)?.[1];
const booliId = url.match(/booli\.se\/(?:annons|bostad)\/(\d+)/)?.[1];
let a = null;
if (hemnetSlug) {
  a = tolkaHemnetSlug(hemnetSlug);
} else if (booliId) {
  sida ??= await hamtaBooliSida(url);
  const plats = sida && booliAdress(sida);
  if (plats) {
    const ortDel = plats.ort && !plats.gata.toLowerCase().includes(plats.ort.toLowerCase()) ? plats.ort : "";
    a = {
      id: `booli-${booliId}`, kalla: "Booli", url, typ: "", rum: null,
      adress: [plats.gata, ortDel].filter(Boolean).join(", "),
      ort: plats.ort, gatuadress: plats.gata, bild: null, pris: null, boarea: null, tomtarea: null,
    };
  }
}
if (!a) {
  await notis({
    titel: "Kunde inte analysera länken",
    meddelande: booliId
      ? "Booli-sidan gick inte att läsa eller saknade adress. Prova igen om en stund, eller klistra in hela annonsen på klistra-in-sidan."
      : "Länken känns inte igen. Klistra in en annons-länk från Hemnet (hemnet.se/bostad/...) eller Booli (booli.se/annons/...).",
    lank: url,
  });
  console.error("Ogiltig länk:", url);
  process.exit(1);
}

// Det annonsen själv säger: pris, byggår, driftkostnad och resten som
// objektsida.js känner igen, samma tolk som klistra-in-sidan kör.
const sidtext = sida ? normaliseraText(htmlTillText(sida)) : "";
const uppgifter = sida ? tolkaObjektsida(sidtext) : {};
if (a.pris == null && uppgifter.pris) a.pris = uppgifter.pris;
const bildlankar = sida ? hittaBilder(sida, url) : [];
console.log(`Analyserar: ${a.adress} (${a.typ || "okänd typ"}${a.rum ? `, ${a.rum} rum` : ""}), ${bildlankar.length} bilder i sidan.`);

const brister = [];
const pendling = [];
const omgivning = [];
const matt = {};

if (a.rum && k.minRum && a.rum < k.minRum) brister.push(`${a.rum} rum (krav: minst ${k.minRum})`);

// Samma uppslag som motorn gör för varje hus (se mailsource.js:
// geokodaAnnonser): gatan, låst till annonsens egen kommun när den är känd.
// Skriptet bar tidigare en egen loop över `a.adressFragor`, ett fält som
// ingen tolk längre fyllde i, så varje länk slutade som "Läge okänt".
const pos = await geokoda(a.gatuadress || a.adress, {
  ort: a.ort,
  kommunText: a.kommunText,
  omraden: config.searches.map((s) => s.namn),
});
if (!pos) {
  // Bilderna och annonsens uppgifter går att granska utan att veta var huset
  // ligger, så ett okänt läge avbryter inte längre analysen.
  pendling.push("Läget okänt: adressen hittades inte på kartan, så avstånden mättes inte");
  brister.push("läget okänt, avstånden gick inte att mäta");
  console.error("Geokodning misslyckades – fortsätter utan avstånd.");
} else {
  console.log(`Koordinater: ${pos.lat}, ${pos.lon}`);

  // Samma anrop och samma biljettbesked som motorn (index.js). Skriptet
  // läste förut `resa.forbestallning`, som inte längre finns, och varnade
  // för flera trafikbolag, vilket var just det fel lan.js beskriver.
  if (harResrobotNyckel()) {
    const h = await narmasteHallplatser(pos.lat, pos.lon, pos.myndighet);
    if (h?.narmaste) {
      pendling.push(`Hållplats: ${h.narmaste.namn} · ${h.narmaste.avstand} m`);
      matt.hallplatsAvstand = h.narmaste.avstand;
      if (h.narmaste.avstand > k.maxAvståndHållplatsM)
        brister.push(`hållplats ${h.narmaste.avstand} m bort (krav: ${k.maxAvståndHållplatsM} m)`);
    } else if (h) {
      pendling.push("Ingen hållplats inom 3 km");
      brister.push("ingen hållplats inom 3 km");
    }
    const resa = await resaTillStockholm(pos.lat, pos.lon, pos.myndighet);
    if (resa) {
      pendling.push(`Stockholm C: ca ${fmtTid(resa.restidMin)}`);
      matt.restidMin = resa.restidMin;
      if (k.maxRestidStockholmMin && resa.restidMin > k.maxRestidStockholmMin)
        brister.push(`restid ${fmtTid(resa.restidMin)} (krav: ${fmtTid(k.maxRestidStockholmMin)})`);
      if (resa.biljett) pendling.push(resa.biljett.tvaBiljetter ? `⚠ ${resa.biljett.text}` : resa.biljett.text);
      for (const text of resa.bokning ?? []) pendling.push(`⚠ ${text}`);
    }
  }

  const n = await naturInfo(pos.lat, pos.lon);
  if (n) {
    omgivning.push(
      `Vatten: ${n.vattenM != null ? "ca " + n.vattenM + " m" : "över 1,5 km"} · ` +
        `Skog: ${n.skogM != null ? "ca " + n.skogM + " m" : "över 1,5 km"}`
    );
    omgivning.push(`Grannar inom 300 m: ${n.grannar}`);
    matt.vattenM = n.vattenM;
    matt.skogM = n.skogM;
    matt.grannar = n.grannar;
    const vattenOk = n.vattenM != null && n.vattenM <= k.maxAvståndVattenM;
    const skogOk = n.skogM != null && n.skogM <= k.maxAvståndSkogM;
    const krav = k.kravNatur ?? "något";
    if (krav === "något" && !vattenOk && !skogOk) brister.push("varken vatten eller skog inom maxavstånd");
    if (krav === "båda" && !(vattenOk && skogOk)) brister.push("vatten och skog krävs båda inom maxavstånd");
    if (n.grannar > k.maxGrannarInom300m)
      brister.push(`${n.grannar} grannbyggnader (krav: max ${k.maxGrannarInom300m})`);
  }
}

const traff = brister.length === 0;
const poang = beraknaPoang(k, matt);
const typNamn = a.typ ? a.typ.charAt(0).toUpperCase() + a.typ.slice(1) : "Bostad";
const fakta = [typNamn, a.rum && `${a.rum} rum`].filter(Boolean).join(" · ");
const prisJmforelse = jamforPris({ pris: a.pris, boarea: a.boarea, ort: a.ort, typ: a.typ }, lasSlutpriser());
const aiOmdome = pos
  ? await skrivBedomning({
      adress: a.adress, typ: typNamn, fakta, pris: a.pris, k, pendling, omgivning, poang, prisJmforelse,
      kommun: pos.kommunNamn, myndighet: pos.myndighet,
    })
  : null;

// Bilderna, med allt annonsen och mätningarna säger som sammanhang: ett
// fuktstråk i en källare väger annorlunda i ett hus från 1962 med stambyte
// gjort än i ett utan uppgifter.
const granskning = await granskaAnnonsbilder({
  urls: bildlankar,
  referer: url,
  adress: a.adress,
  fakta: [
    a.pris != null && `Pris: ${a.pris.toLocaleString("sv-SE")} kr`,
    prisJmforelse &&
      `Kronor per kvadratmeter ${Math.abs(prisJmforelse.diffProcent)} % ${prisJmforelse.diffProcent <= 0 ? "under" : "över"} snittet för ${prisJmforelse.antalJamforelser} nyligen sålda jämförbara hus`,
    fakta,
    ...kandaUppgifter(uppgifter).filter((r) => !r.startsWith("Pris i annonsen")),
  ].filter(Boolean),
  beskrivning: sidtext,
});
const bildrader = granskning
  ? bildgranskningNotis(granskning)
  : bildlankar.length
    ? [harNyckel() ? "Bilderna granskades inte den här gången, se körningens logg." : "Bildgranskningen är inte påslagen: ANTHROPIC_API_KEY saknas."]
    : hemnetSlug && !sida
      ? ["Bilderna kom inte med: Hemnet spärrar automatisk hämtning. Skicka annonsen med bokmärket på klistra-in-sidan, så granskas bilderna."]
      : [];

const sektion = (rubrik, rader) => (rader.length ? ["", rubrik, ...rader] : []);
await notis({
  titel: traff ? `Analys: Träff · ${a.adress}` : `Analys: ${a.adress}`,
  meddelande: [
    a.adress,
    ...(fakta ? [fakta] : []),
    ...sektion("PENDLING", pendling),
    ...sektion("OMGIVNING", omgivning),
    poang != null ? `\nMatchning: ${poang}/100` : "",
    aiOmdome ?? "",
    ...sektion("BILDERNA", bildrader),
    ...sektion("BEDÖMNING", traff ? ["✓ Uppfyller alla dina krav"] : brister.map((b) => `✗ ${b}`)),
  ].filter(Boolean).join("\n"),
  lank: a.url,
  bild: a.bild ?? bildlankar[0],
  lat: pos?.lat,
  lon: pos?.lon,
  prioritet: traff ? 4 : 3,
});

// Spara i galleriet (manuellt analyserade hus hamnar också bland Bostäder)
const lagrade = new Map(lasTraffar().map((t) => [t.id, t]));
const tidigareHus = lagrade.get(a.id);
const prisSankning =
  a.pris != null && tidigareHus?.pris != null && a.pris < tidigareHus.pris
    ? { fran: tidigareHus.pris, till: a.pris, tidpunkt: new Date().toISOString() }
    : (tidigareHus?.prisSankning ?? null);
lagrade.set(a.id, {
  ...lagrade.get(a.id),
  id: a.id,
  tidpunkt: new Date().toISOString(),
  kalla: `${a.kalla} · analyserad`,
  typ: a.typ ? typNamn : "",
  omrade: a.ort || "",
  adress: a.adress,
  pris: a.pris ?? null,
  rum: a.rum ?? null,
  boarea: a.boarea ?? null,
  tomtarea: a.tomtarea ?? null,
  restidMin: matt.restidMin ?? null,
  prisJmforelse,
  prisSankning,
  url: a.url,
  bild: a.bild ?? bildlankar[0] ?? null,
  lat: pos?.lat ?? null,
  lon: pos?.lon ?? null,
  pendling,
  omgivning,
  uppfyller: traff,
  poang,
  aiOmdome,
});
sparaTraffar([...lagrade.values()]);

// Annonsens uppgifter och bildernas omdöme sparas som husuppgifter, inte på
// husposten, av samma skäl som de inklistrade (se index.js): de ska överleva
// att huset faller ur flödet, och workflowens merge.js lägger dem fält för
// fält ovanpå den senaste filen.
const nya = { ...uppgifter, ...(granskning ? { bildgranskning: granskning } : {}) };
if (Object.keys(nya).length) {
  writeFileSync(nyaUppgifterFil, JSON.stringify({ [a.id]: { ...nya, uppdaterad: new Date().toISOString() } }, null, 2) + "\n");
}

console.log(traff ? "TRÄFF – notis skickad, sparad i galleriet." : `Brister: ${brister.join("; ")} – notis skickad, sparad i galleriet.`);
