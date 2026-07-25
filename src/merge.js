// Slår ihop den här körningens data (sparad undan före en hård reset) med
// den senaste versionen från origin. Körs i workflowens spara-loop så att
// samtidiga körningar aldrig krockar. Anropas som:
//   node src/merge.js <mina-traffar.json> [<mina-seen.json>] [<mina-slutpriser.json>]
// och skriver de sammanslagna data/traffar.json (+ seen.json/slutpriser.json om angivna).
import { readFileSync, writeFileSync } from "node:fs";

const [, , minaTraffarPath, minaSeddaPath, minaSlutpriserPath] = process.argv;
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

// Hårda filter (samma som index.js) tillämpas även här, annars kan unionen
// lägga tillbaka hus som ligger utanför kraven (t.ex. över maxpris).
const cfg = las("config.json", { kriterier: {} });
const k = cfg.kriterier || {};
const normTyp = (s) => (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const tillatna = (k.objectType || "").split(",").map((t) => normTyp(t.trim())).filter(Boolean);
const utanfor = (t) =>
  (tillatna.length && t.typ && !tillatna.includes(normTyp(t.typ))) ||
  (k.maxPris && t.pris && t.pris > k.maxPris) ||
  (k.minRum && t.rum && t.rum < k.minRum) ||
  (k.minBoarea && t.boarea && t.boarea < k.minBoarea) ||
  (k.minTomtarea && t.tomtarea && t.tomtarea < k.minTomtarea);

const traffar = [...karta.values()]
  .filter((t) => !t.dold && !utanfor(t))
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
