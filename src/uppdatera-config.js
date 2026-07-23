// Uppdaterar config.json utifrån miljövariabler från formuläret i
// workflowen "Ändra inställningar". Tomma fält lämnas oförändrade.
import { readFileSync, writeFileSync } from "node:fs";

const FIL = new URL("../config.json", import.meta.url);
const config = JSON.parse(readFileSync(FIL, "utf8"));
const k = config.kriterier;

const tal = (namn) => {
  const v = process.env[namn]?.trim().replace(/[\s.]/g, "");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isNaN(n) || n < 0) throw new Error(`Ogiltigt tal för ${namn}: "${process.env[namn]}"`);
  return n;
};
const jaNej = (namn) => {
  const v = process.env[namn]?.trim().toLowerCase();
  return v === "ja" ? true : v === "nej" ? false : undefined;
};

const omraden = process.env.OMRADEN?.trim();
if (omraden) {
  config.searches = omraden
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((namn) => ({ namn, q: namn }));
}

const maxPris = tal("MAX_PRIS");
if (maxPris !== undefined) k.maxPris = maxPris === 0 ? null : maxPris;

for (const [env, falt] of [
  ["MAX_HALLPLATS", "maxAvståndHållplatsM"],
  ["MAX_VATTEN", "maxAvståndVattenM"],
  ["MAX_SKOG", "maxAvståndSkogM"],
  ["MAX_GRANNAR", "maxGrannarInom300m"],
]) {
  const v = tal(env);
  if (v !== undefined) k[falt] = v;
}

const kravNatur = jaNej("KRAV_NATUR");
if (kravNatur !== undefined) k.kravNatur = kravNatur ? "något" : "inget";

const endastTraffar = jaNej("ENDAST_TRAFFAR");
if (endastTraffar !== undefined) config.notiser.endastTräffar = endastTraffar;

writeFileSync(FIL, JSON.stringify(config, null, 2) + "\n");

console.log("Nya inställningar:\n");
console.log(JSON.stringify(config, null, 2));
