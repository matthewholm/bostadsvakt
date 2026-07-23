// Analyserar en enskild annons-länk (klistras in i kontrollpanelen):
// tolkar adressen, mäter pendling/natur och pushar resultatet – oavsett
// om huset uppfyller kraven eller inte, med tydlig lista på vad som brister.
import { readFileSync } from "node:fs";
import { tolkaHemnetSlug } from "./mailsource.js";
import { geokoda } from "./geocode.js";
import { narmasteHallplatser, restidTillStockholm, harResrobotNyckel } from "./transit.js";
import { naturInfo } from "./nature.js";
import { notis } from "./notify.js";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
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
const rader = [];

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
      rader.push(`Hållplats: ${h.narmaste.namn} · ${h.narmaste.avstand} m`);
      if (h.narmaste.avstand > k.maxAvståndHållplatsM)
        brister.push(`hållplats ${h.narmaste.avstand} m bort (krav: ${k.maxAvståndHållplatsM} m)`);
    } else if (h) {
      rader.push("Ingen hållplats inom 3 km");
      brister.push("ingen hållplats inom 3 km");
    }
    const restid = await restidTillStockholm(pos.lat, pos.lon);
    if (restid != null) {
      rader.push(`Till Stockholm C: ca ${fmtTid(restid)}`);
      if (k.maxRestidStockholmMin && restid > k.maxRestidStockholmMin)
        brister.push(`restid ${fmtTid(restid)} (krav: ${fmtTid(k.maxRestidStockholmMin)})`);
    }
  }

  const n = await naturInfo(pos.lat, pos.lon);
  if (n) {
    rader.push(
      `Vatten: ${n.vattenM != null ? "ca " + n.vattenM + " m" : "över 1,5 km"} · ` +
        `Skog: ${n.skogM != null ? "ca " + n.skogM + " m" : "över 1,5 km"} · ` +
        `Grannar: ${n.grannar}`
    );
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
await notis({
  titel: traff ? `Analys: Träff · ${a.adress}` : `Analys: ${a.adress}`,
  meddelande: [
    ...rader,
    traff ? "✓ Uppfyller alla dina krav" : `Brister: ${brister.join("; ")}`,
  ].join("\n"),
  lank: a.url,
  lat: pos?.lat,
  lon: pos?.lon,
  prioritet: traff ? 4 : 3,
});
console.log(traff ? "TRÄFF – notis skickad." : `Brister: ${brister.join("; ")} – notis skickad.`);
