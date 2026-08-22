// Analyserar en enskild annons-länk (klistras in i kontrollpanelen):
// tolkar adressen, mäter pendling/natur och pushar resultatet – oavsett
// om huset uppfyller kraven eller inte, med tydlig lista på vad som brister.
import { readFileSync } from "node:fs";
import { tolkaHemnetSlug } from "./mailsource.js";
import { geokoda } from "./geocode.js";
import { narmasteHallplatser, resaTillStockholm, harResrobotNyckel } from "./transit.js";
import { naturInfo } from "./nature.js";
import { notis } from "./notify.js";
import { lasTraffar, sparaTraffar } from "./matches.js";
import { beraknaPoang } from "./score.js";
import { skrivBedomning } from "./ai.js";
import { lasSlutpriser, jamforPris } from "./slutpriser.js";

const config = JSON.parse(readFileSync(new URL("../data-repo/config.json", import.meta.url), "utf8"));
const k = config.kriterier;
const fmtTid = (min) => (min >= 60 ? `${Math.floor(min / 60)} tim ${min % 60} min` : `${min} min`);

const url = (process.env.ANNONS_URL ?? "").trim();
if (!url) {
  console.error("Ingen länk angiven (ANNONS_URL).");
  process.exit(1);
}

const hemnetSlug = url.match(/hemnet\.se\/bostad\/([a-z0-9-]+)/)?.[1];
if (!hemnetSlug) {
  const arBooli = /booli\.se/.test(url);
  await notis({
    titel: "Kunde inte analysera länken",
    meddelande: arBooli
      ? "Booli-länkar innehåller ingen adress att gå på – analysen fungerar med Hemnet-länkar (hemnet.se/bostad/...)."
      : "Länken känns inte igen. Klistra in en annons-länk från Hemnet (hemnet.se/bostad/...).",
    lank: url,
  });
  console.error("Ogiltig länk:", url);
  process.exit(1);
}

const a = tolkaHemnetSlug(hemnetSlug);
if (!a) {
  console.error("Kunde inte tolka Hemnet-länken:", hemnetSlug);
  process.exit(1);
}
console.log(`Analyserar: ${a.adress} (${a.typ || "okänd typ"}${a.rum ? `, ${a.rum} rum` : ""})`);

const brister = [];
const pendling = [];
const omgivning = [];
const matt = {};

if (a.rum && k.minRum && a.rum < k.minRum) brister.push(`${a.rum} rum (krav: minst ${k.minRum})`);

let pos = null;
for (const fraga of a.adressFragor ?? []) {
  pos = await geokoda(fraga);
  if (pos) break;
  await new Promise((r) => setTimeout(r, 1100));
}
if (!pos) {
  await notis({
    titel: `Analys: Läge okänt · ${a.adress}`,
    meddelande:
      "Adressen kunde inte hittas på kartan, så avstånden gick inte att mäta. " +
      "Prova igen om en stund – eller kontrollera annonsen manuellt.",
    lank: a.url,
  });
  console.error("Geokodning misslyckades – notis om okänt läge skickad.");
  process.exit(0);
} else {
  console.log(`Koordinater: ${pos.lat}, ${pos.lon}`);

  if (harResrobotNyckel()) {
    const h = await narmasteHallplatser(pos.lat, pos.lon);
    if (h?.narmaste) {
      pendling.push(`Hållplats: ${h.narmaste.namn} · ${h.narmaste.avstand} m`);
      matt.hallplatsAvstand = h.narmaste.avstand;
      if (h.narmaste.avstand > k.maxAvståndHållplatsM)
        brister.push(`hållplats ${h.narmaste.avstand} m bort (krav: ${k.maxAvståndHållplatsM} m)`);
    } else if (h) {
      pendling.push("Ingen hållplats inom 3 km");
      brister.push("ingen hållplats inom 3 km");
    }
    const resa = await resaTillStockholm(pos.lat, pos.lon);
    if (resa) {
      pendling.push(`Stockholm C: ca ${fmtTid(resa.restidMin)}`);
      matt.restidMin = resa.restidMin;
      if (k.maxRestidStockholmMin && resa.restidMin > k.maxRestidStockholmMin)
        brister.push(`restid ${fmtTid(resa.restidMin)} (krav: ${fmtTid(k.maxRestidStockholmMin)})`);
      if (resa.operatorer.length > 1) {
        pendling.push(`⚠ Flera trafikbolag (${resa.operatorer.join(" + ")}) – kan kräva separata biljetter`);
      }
      for (const text of resa.forbestallning) {
        pendling.push(`⚠ Kräver förbeställning: ${text}`);
      }
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
const aiOmdome = await skrivBedomning({
  adress: a.adress, typ: typNamn, fakta, pris: a.pris, k, pendling, omgivning, poang, prisJmforelse,
});
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
    ...sektion("BEDÖMNING", traff ? ["✓ Uppfyller alla dina krav"] : brister.map((b) => `✗ ${b}`)),
  ].filter(Boolean).join("\n"),
  lank: a.url,
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
  bild: a.bild ?? null,
  lat: pos?.lat ?? null,
  lon: pos?.lon ?? null,
  pendling,
  omgivning,
  uppfyller: traff,
  poang,
  aiOmdome,
});
sparaTraffar([...lagrade.values()]);

console.log(traff ? "TRÄFF – notis skickad, sparad i galleriet." : `Brister: ${brister.join("; ")} – notis skickad, sparad i galleriet.`);
