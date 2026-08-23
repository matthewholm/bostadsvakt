// Bygger data/sida.json ur data/traffar.json – husflödet i den generiska
// { items: [{ id, title, image, url, links, sortable, rader }] }-form vilken
// sida som helst kan rita utan att veta vad ett hus är. Körs i workflowens
// spara-loop, EFTER merge.js och INNE I data-repo/-checkouten, så att sidan
// alltid speglar den nyss sammanslagna versionen av traffar.json och inte
// en gammal. Anropas som:
//   node ../src/sida.js
// och läser/skriver relativt CWD – som ska vara data-repo/ när det här körs.
//
// id/title/image/url/links/sortable är strukturerade fält – det är dem Alva
// behöver för att spara/dölja/anteckna ett hus även efter att det försvunnit
// ur flödet (sålt, borttaget), rita klickbara länkar i stället för URL:er
// som text, och sortera listan på ett tal i stället för en formaterad
// sträng ("3 995 000 kr" går inte att sortera på utan att veta vilken
// formatering just den här sidan råkar använda). Både `links` och
// `sortable` är avsiktligt generiska (etikett + värde, ingen
// "mäklarlänk"/"pris"-nyckel) – det som råkar vara husets pris för det här
// huset är för en annan källa kanske en helt annan sorts tal. Allt annat –
// pendling, omgivning, matchning, AI-omdöme – är fritext i rader, för det
// är just det de är: text ingen sida behöver förstå strukturen av, bara visa.
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
    [hus.typ, kr(hus.pris), hus.rum && `${hus.rum} rum`, hus.boarea && `${hus.boarea} m²`, hus.byggar && `byggt ${hus.byggar}`]
      .filter(Boolean)
      .join(" · "),
    hus.poang != null && (hus.uppfyller ? `Träff · ${hus.poang} poäng` : `${hus.poang} poäng`),
    hus.prisSankning && `Prissänkt: ${kr(hus.prisSankning.fran)} → ${kr(hus.prisSankning.till)}`,
    // AI-omdömet läggs direkt efter poängen, inte sist av allt – det är
    // en syntes av matchning, ekonomi, pendling och omgivning på en gång
    // (se index.js:skrivBedomning), alltså slutsatsen, medan sektionerna
    // nedanför är underlaget den byggde på. En läsare vill veta vad AI:n
    // tycker innan hen bläddrar igenom bevisen, inte efter.
    hus.aiOmdome && ["", "AI-OMDÖME", hus.aiOmdome],
    // Hus som fanns innan sektioner-fältet byggdes (se index.js) har ännu
    // inte fått det ifyllt av en färsk körning – då faller vi tillbaka på
    // de äldre platta fälten i stället för att tappa raderna helt.
    ...(hus.sektioner
      ? hus.sektioner.flatMap((s) => sektion(s.titel, s.rader))
      : [...sektion("PENDLING", hus.pendling), ...sektion("OMGIVNING", hus.omgivning), ...sektion("EKONOMI", hus.ekonomiRader)]),
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
    links: hus.maklarlank ? [{ label: "Öppna hos mäklaren", url: hus.maklarlank }] : undefined,
    sortable: [
      hus.poang != null && { label: "Matchning", value: hus.poang },
      hus.pris != null && { label: "Pris", value: hus.pris },
      hus.byggar != null && { label: "Ålder", value: hus.byggar },
    ].filter(Boolean),
    rader,
  };
};

const poster = [...traffar]
  .filter((hus) => hus.id)
  .sort((a, b) => (b.tidpunkt ?? "").localeCompare(a.tidpunkt ?? ""))
  .map(post);

writeFileSync("data/sida.json", JSON.stringify({ items: poster }, null, 2) + "\n");
