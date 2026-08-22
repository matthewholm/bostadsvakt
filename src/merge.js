// Slår ihop den här körningens sedda-lista och slutpriser (sparade undan
// före en hård reset) med den senaste versionen från origin. Körs i
// workflowens spara-loop så att samtidiga körningar aldrig krockar.
// Anropas som:
//   node src/merge.js <mina-seen.json> [<mina-slutpriser.json>]
//
// Husflödet självt slås inte längre ihop här – det postas till Alva direkt
// från index.js/analysera.js, och behöver ingen git-merge: `bostadsvakt.yml`
// och `analysera.yml` delar samma concurrency-grupp, så de kör aldrig
// samtidigt, och Alvas replaceFeed skriver alltid den fullständiga listan
// från en körning som redan läst det senaste läget.
import { readFileSync, writeFileSync } from "node:fs";

const [, , minaSeddaPath, minaSlutpriserPath] = process.argv;
const las = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

// Sedda annonser: union av två id-listor
if (minaSeddaPath) {
  const bas = las("data/seen.json", []);
  const mina = las(minaSeddaPath, []);
  const alla = [...new Set([...bas, ...mina])].sort();
  writeFileSync("data/seen.json", JSON.stringify(alla, null, 2) + "\n");
}

// Slutpriser: slå ihop, kasta det som blivit för gammalt, begränsa storleken
// (samma regler som src/slutpriser.js – hålls i synk manuellt).
if (minaSlutpriserPath) {
  const MAX_POSTER = 400;
  const MAX_ALDER_DAGAR = 270;
  const bas = las("data/slutpriser.json", []);
  const mina = las(minaSlutpriserPath, []);
  const grans = Date.now() - MAX_ALDER_DAGAR * 86400000;
  const alla = [...bas, ...mina]
    .filter((p) => new Date(p.datum).getTime() >= grans)
    .sort((a, b) => (b.datum ?? "").localeCompare(a.datum ?? ""))
    .slice(0, MAX_POSTER);
  writeFileSync("data/slutpriser.json", JSON.stringify(alla, null, 2) + "\n");
}
