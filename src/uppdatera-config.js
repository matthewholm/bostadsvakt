// Uppdaterar config.json utifrån miljövariabler från formuläret i
// workflowen "Ändra inställningar". Tomma fält lämnas oförändrade.
import { readFileSync, writeFileSync } from "node:fs";

const FIL = new URL("../data-repo/config.json", import.meta.url);
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

// ---- Hela uppsättningen som JSON ---------------------------------------
//
// Formuläret ovan täcker åtta fält; kriterierna är fler, och GitHub tillåter
// bara tio inputs per workflow. Det här fältet tar allt i ett svep istället.
//
// Det kommer utifrån, så inget tas på förtroende: bara kända fält skrivs, och
// bara med rätt typ. Ett okänt eller felaktigt fält avbryter hellre hela
// ändringen än skriver halva – en tyst halvsparad kriterieuppsättning är värre
// än ett fel, eftersom bevakningen då letar efter fel saker utan att någon vet.
const TAL_FALT = new Set([
  "maxPris", "minRum", "minBoarea", "minTomtarea",
  "maxAvståndHållplatsM", "maxRestidStockholmMin",
  "maxAvståndVattenM", "maxAvståndSkogM", "maxGrannarInom300m",
]);
const NATURKRAV = new Set(["något", "båda", "inget"]);

const json = process.env.KRITERIER_JSON?.trim();
if (json) {
  let inkommet;
  try {
    inkommet = JSON.parse(json);
  } catch (err) {
    throw new Error(`KRITERIER_JSON är inte giltig JSON: ${err.message}`);
  }
  if (typeof inkommet !== "object" || inkommet === null) {
    throw new Error("KRITERIER_JSON måste vara ett objekt.");
  }

  for (const [falt, varde] of Object.entries(inkommet.kriterier ?? {})) {
    if (TAL_FALT.has(falt)) {
      // null betyder "inget tak" och är giltigt – t.ex. maxPris utan gräns.
      if (varde === null) { k[falt] = null; continue; }
      const n = Number(varde);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Ogiltigt värde för ${falt}: ${JSON.stringify(varde)}`);
      k[falt] = n;
    } else if (falt === "objectType") {
      const v = String(varde ?? "").trim();
      if (!v) throw new Error("objectType får inte vara tomt.");
      k.objectType = v;
    } else if (falt === "kravNatur") {
      if (!NATURKRAV.has(varde)) throw new Error(`kravNatur måste vara något/båda/inget, fick ${JSON.stringify(varde)}`);
      k.kravNatur = varde;
    } else {
      throw new Error(`Okänt kriterium: ${falt}`);
    }
  }

  if (Array.isArray(inkommet.searches)) {
    const namn = inkommet.searches.map((x) => String(x?.namn ?? x).trim()).filter(Boolean);
    if (!namn.length) throw new Error("searches får inte vara tom – då bevakas ingenting.");
    config.searches = namn.map((n) => ({ namn: n, q: n }));
  }
  if (typeof inkommet.notiser?.endastTräffar === "boolean") {
    config.notiser.endastTräffar = inkommet.notiser.endastTräffar;
  }
}

writeFileSync(FIL, JSON.stringify(config, null, 2) + "\n");

console.log("Nya inställningar:\n");
console.log(JSON.stringify(config, null, 2));
