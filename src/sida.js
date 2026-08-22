// Bygger data/sida.json ur data/traffar.json – husflödet i den generiska
// { items: [{ id, title, image, url, rader }] }-form vilken sida som helst
// kan rita utan att veta vad ett hus är. Körs i workflowens spara-loop,
// EFTER merge.js och INNE I data-repo/-checkouten, så att sidan alltid
// speglar den nyss sammanslagna versionen av traffar.json och inte en
// gammal. Anropas som:
//   node ../src/sida.js
// och läser/skriver relativt CWD – som ska vara data-repo/ när det här körs.
//
// id/title/image/url är strukturerade fält – det är dem Alva behöver för
// att spara/dölja/anteckna ett hus även efter att det försvunnit ur
// flödet (sålt, borttaget). Allt annat – pendling, omgivning, matchning,
// AI-omdöme – är fritext i rader, för det är just det de är: text ingen
// sida behöver förstå strukturen av, bara visa.
import { readFileSync, writeFileSync } from "node:fs";

const traffar = JSON.parse(readFileSync("data/traffar.json", "utf8"));

const kr = (n) => (n == null ? null : n.toLocaleString("sv-SE") + " kr");

// Samma flätning som notisens egen radbyggare i index.js: en rubrikrad,
// sedan raderna, med en tom rad före som luft mellan grupper. Tom grupp
// blir ingenting alls, så ett hus utan pendlingsdata inte visar en tom
// rubrik.
const sektion = (rubrik, rader) => (rader?.length ? ["", rubrik, ...rader] : []);

const post = (hus) => {
  const rader = [
    [hus.typ, kr(hus.pris), hus.rum && `${hus.rum} rum`, hus.boarea && `${hus.boarea} m²`]
      .filter(Boolean)
      .join(" · "),
    hus.poang != null && (hus.uppfyller ? `🎯 Träff · ${hus.poang} poäng` : `${hus.poang} poäng`),
    hus.prisSankning && `Prissänkt: ${kr(hus.prisSankning.fran)} → ${kr(hus.prisSankning.till)}`,
    // Hus som fanns innan sektioner-fältet byggdes (se index.js) har ännu
    // inte fått det ifyllt av en färsk körning – då faller vi tillbaka på
    // de äldre platta fälten i stället för att tappa raderna helt.
    ...(hus.sektioner
      ? hus.sektioner.flatMap((s) => sektion(s.titel, s.rader))
      : [...sektion("PENDLING", hus.pendling), ...sektion("OMGIVNING", hus.omgivning), ...sektion("EKONOMI", hus.ekonomiRader)]),
    hus.aiOmdome && ["", "AI-OMDÖME", hus.aiOmdome],
  ]
    .flat()
    // Filtrerar bort de rader som var villkorliga (false, inte bara "" eller
    // null) och samtidigt skydd mot att en icke-sträng smyger med ut – Alva
    // vägrar hela sidan om en enda rad inte är text (se dess
    // externalConnections/service.ts).
    .filter((rad) => typeof rad === "string" && rad !== "");

  return {
    id: hus.id,
    title: [hus.adress, hus.omrade].filter(Boolean).join(" · ") || "(okänd adress)",
    image: hus.bild || undefined,
    url: hus.url || undefined,
    rader,
  };
};

const poster = [...traffar]
  .filter((hus) => hus.id)
  .sort((a, b) => (b.tidpunkt ?? "").localeCompare(a.tidpunkt ?? ""))
  .map(post);

writeFileSync("data/sida.json", JSON.stringify({ items: poster }, null, 2) + "\n");
