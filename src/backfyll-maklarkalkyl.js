// Engångsskript: fyller i byggår, mäklarlänk och mäklarens boendekalkyl på
// hus som redan finns i flödet men kom in innan de fälten fanns (se
// annonsberikning.js/maklarkalkyl.js) – annars visar husflödet aldrig dolda
// kostnader på ett hus som redan hittats, bara på nya som råkar dyka upp
// efteråt. Skriver bara de ändrade posterna, i samma { id, ...fält }-form
// som merge.js redan vet hur den ska slå ihop med data-repo:ts traffar.json
// – körs en gång via ett manuellt workflow_dispatch, sedan tas den och
// arbetsflödet bort. Anropas som:
//   node src/backfyll-maklarkalkyl.js <traffar.json> <output.json>
import { readFileSync, writeFileSync } from "node:fs";
import { berikaFranBooli, arBooliAnnons } from "./annonsberikning.js";
import { hamtaMaklarkalkyl } from "./maklarkalkyl.js";

const [, , inPath, outPath] = process.argv;
const traffar = JSON.parse(readFileSync(inPath, "utf8"));
const paus = (ms) => new Promise((r) => setTimeout(r, ms));

const andrade = [];
for (const h of traffar) {
  if (!arBooliAnnons({ id: h.id, url: h.url })) continue;
  // Samma flagga som index.js självt sätter efter ett försök, lyckat eller
  // inte – ett hus som redan svarat (även tomt) ska inte betala en headless
  // webbläsare igen.
  if (h.maklarkalkylHamtad) continue;

  console.log(`Berikar ${h.id} ${h.adress ?? ""}...`);
  const berikning = await berikaFranBooli({ id: h.id, url: h.url });
  await paus(800);

  const maklarkalkylHamtad = Boolean(berikning.maklarlank);
  const maklarkalkyl = berikning.maklarlank ? await hamtaMaklarkalkyl(berikning.maklarlank) : null;

  // Samma radbygge som index.js – se det för varför.
  const maklarkalkylRader = maklarkalkyl
    ? [
        maklarkalkyl.driftkostnadManad != null &&
          `Driftkostnad enligt mäklaren: ${maklarkalkyl.driftkostnadManad.toLocaleString("sv-SE")} kr/mån`,
        maklarkalkyl.lagfart != null && `Lagfart enligt mäklaren: ${maklarkalkyl.lagfart.toLocaleString("sv-SE")} kr`,
        maklarkalkyl.amorteringManad != null &&
          `Amortering enligt mäklarens kalkyl: ${maklarkalkyl.amorteringManad.toLocaleString("sv-SE")} kr/mån`,
      ].filter(Boolean)
    : [];
  const sektioner = (h.sektioner ?? []).filter((s) => s.titel !== "MÄKLARENS KALKYL");
  if (maklarkalkylRader.length) sektioner.push({ titel: "MÄKLARENS KALKYL", rader: maklarkalkylRader });

  andrade.push({
    id: h.id,
    byggar: berikning.byggar ?? h.byggar ?? null,
    maklarlank: berikning.maklarlank ?? h.maklarlank ?? null,
    maklarkalkyl,
    maklarkalkylHamtad,
    sektioner,
  });
}

writeFileSync(outPath, JSON.stringify(andrade, null, 2) + "\n");
console.log(`${andrade.length} hus uppdaterade.`);
