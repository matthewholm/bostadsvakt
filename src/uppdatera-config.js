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

// null är giltigt för alla tal här: "inget tak" i kriterier, "inte ifylld"
// i hushall – exakt den skillnad harRad() i ekonomi.js redan bygger sin
// "okänt, inte ett gissat nej"-hållning på.
const talEllerNull = (namn, varde) => {
  if (varde === null) return null;
  const n = Number(varde);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Ogiltigt värde för ${namn}: ${JSON.stringify(varde)}`);
  return n;
};

// Hushållsekonomin (se ekonomi.js) har ingen egen plats i formuläret ovan –
// bara den handskrivna filredigeringen kunde ändra den, utan att något
// kontrollerade att "45 000" (mellanslag, precis så någon skriver det för
// hand) inte tyst blev NaN i varje framtida "har vi råd"-beräkning.
const HUSHALL_TAL_FALT = new Set(["nettoinkomstManad", "kontantinsatsTillgangligt", "ovrigaLanManad"]);
const ANTAGANDE_TAL_FALT = new Set(["ranta", "kalkylranta", "driftskostnadKvmAr"]);
const NUVARANDE_BOSTAD_TAL_FALT = new Set(["varde", "kvarstaendeLan", "maklarkostnadProcent"]);

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
      k[falt] = talEllerNull(falt, varde);
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

  if (inkommet.hushall !== undefined) {
    if (typeof inkommet.hushall !== "object" || inkommet.hushall === null) {
      throw new Error("hushall måste vara ett objekt.");
    }
    config.hushall ??= {};
    const h = config.hushall;

    for (const [falt, varde] of Object.entries(inkommet.hushall)) {
      if (HUSHALL_TAL_FALT.has(falt)) {
        h[falt] = talEllerNull(falt, varde);
      } else if (falt === "antagande") {
        if (typeof varde !== "object" || varde === null) throw new Error("hushall.antagande måste vara ett objekt.");
        h.antagande ??= {};
        for (const [af, av] of Object.entries(varde)) {
          if (!ANTAGANDE_TAL_FALT.has(af)) throw new Error(`Okänt fält i hushall.antagande: ${af}`);
          h.antagande[af] = talEllerNull(`antagande.${af}`, av);
        }
      } else if (falt === "nuvarandeBostad") {
        // null tar bort hela avsnittet – hushållet har inte längre en
        // nuvarande bostad att räkna en försäljning på.
        if (varde === null) { h.nuvarandeBostad = null; continue; }
        if (typeof varde !== "object") throw new Error("hushall.nuvarandeBostad måste vara ett objekt eller null.");
        h.nuvarandeBostad ??= {};
        for (const [nf, nv] of Object.entries(varde)) {
          if (!NUVARANDE_BOSTAD_TAL_FALT.has(nf)) throw new Error(`Okänt fält i hushall.nuvarandeBostad: ${nf}`);
          h.nuvarandeBostad[nf] = talEllerNull(`nuvarandeBostad.${nf}`, nv);
        }
      } else {
        throw new Error(`Okänt hushållsfält: ${falt}`);
      }
    }
  }
}

writeFileSync(FIL, JSON.stringify(config, null, 2) + "\n");

console.log("Nya inställningar:\n");
console.log(JSON.stringify(config, null, 2));
