// Slår ihop den här körningens data (sparad undan före en hård reset) med
// den senaste versionen från origin. Körs i workflowens spara-loop så att
// samtidiga körningar aldrig krockar. Anropas som:
//   node src/merge.js <mina-traffar.json> [<mina-seen.json>]
// och skriver de sammanslagna data/traffar.json (+ data/seen.json om angiven).
import { readFileSync, writeFileSync } from "node:fs";

const [, , minaTraffarPath, minaSeddaPath] = process.argv;
const las = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

// Träffar: unionera på id, mina värden vinner; behåll ev. panel-flaggor (dold)
const basT = las("data/traffar.json", []);
const minaT = las(minaTraffarPath, []);
const karta = new Map(basT.map((t) => [t.id, t]));
for (const t of minaT) karta.set(t.id, { ...karta.get(t.id), ...t });
const traffar = [...karta.values()]
  .filter((t) => !t.dold)
  .sort((a, b) => (b.tidpunkt ?? "").localeCompare(a.tidpunkt ?? ""))
  .slice(0, 100);
writeFileSync("data/traffar.json", JSON.stringify(traffar, null, 2) + "\n");

// Sedda annonser: union av två id-listor
if (minaSeddaPath) {
  const bas = las("data/seen.json", []);
  const mina = las(minaSeddaPath, []);
  const alla = [...new Set([...bas, ...mina])].sort();
  writeFileSync("data/seen.json", JSON.stringify(alla, null, 2) + "\n");
}
