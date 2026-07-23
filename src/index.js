// Bostadsvakt – letar nya bostäder via Booli-API och/eller bevakningsmejl
// (Hemnet + Booli), kollar pendling (ResRobot), vatten/skog/grannar
// (OpenStreetMap) och skickar push-notiser via ntfy.
import { readFileSync } from "node:fs";
import { harBooliNycklar, sokAnnonser } from "./booli.js";
import { harImap, hamtaMailAnnonser } from "./mailsource.js";
import { narmasteHallplatser, harResrobotNyckel } from "./transit.js";
import { naturInfo } from "./nature.js";
import { notis } from "./notify.js";
import { lasSedda, sparaSedda } from "./state.js";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const k = config.kriterier;
const paus = (ms) => new Promise((r) => setTimeout(r, ms));
const normTyp = (s) => (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

// Testläge: kör hela kedjan på ett låtsashus utan att behöva några nycklar.
if (process.argv.includes("--test")) {
  await korTest();
  process.exit(0);
}

if (!harBooliNycklar() && !harImap()) {
  console.error(
    "Ingen datakälla är konfigurerad. Sätt antingen:\n" +
      "  • BOOLI_CALLER_ID + BOOLI_PRIVATE_KEY (Boolis API), eller\n" +
      "  • IMAP_USER + IMAP_PASSWORD (inkorg med bevakningsmejl från Hemnet/Booli)\n" +
      "Se README.md för detaljer."
  );
  process.exit(1);
}
if (!harResrobotNyckel()) {
  console.warn("RESROBOT_API_KEY saknas – hållplatskollen hoppas över tills du lagt in en nyckel.");
}

const sedda = lasSedda();
const forstaKorning = sedda.size === 0;
let nya = 0;
let traffar = 0;

// ---- Samla annonser från alla källor ----
const annonser = [];

if (harBooliNycklar()) {
  for (const sok of config.searches) {
    console.log(`\nBooli-sökning: ${sok.namn} (${k.objectType})...`);
    try {
      const lista = await sokAnnonser({ q: sok.q, objectType: k.objectType });
      console.log(`  ${lista.length} annonser hittade.`);
      // bulk: API:t returnerar hela utbudet – första körningen ska inte ge notisflod
      annonser.push(...lista.map((a) => ({ ...a, kalla: "Booli", omrade: sok.namn, bulk: true })));
    } catch (err) {
      console.error(`  Fel vid sökning: ${err.message}`);
    }
  }
} else {
  console.log("Booli-nycklar saknas – hoppar över Booli-API:t.");
}

if (harImap()) {
  console.log("\nLäser bevakningsmejl (Hemnet/Booli)...");
  try {
    const lista = await hamtaMailAnnonser();
    console.log(`  ${lista.length} annonser i mejlen.`);
    annonser.push(...lista);
  } catch (err) {
    console.error(`  Kunde inte läsa inkorgen: ${err.message}`);
  }
}

// ---- Bedöm och notifiera ----
const tillatnaTyper = k.objectType.split(",").map(normTyp);

for (const a of annonser) {
  if (sedda.has(a.id)) continue;
  sedda.add(a.id);
  nya++;

  // Vid allra första API-körningen markeras hela utbudet som sett utan
  // notiser – mejlkällan innehåller däremot bara nyheter och notifierar alltid.
  if (forstaKorning && a.bulk) continue;

  // Hustyp (mejlkällan kan innehålla andra typer än de valda)
  if (a.typ && !tillatnaTyper.includes(normTyp(a.typ))) {
    console.log(`  Fel hustyp (${a.typ}): ${a.adress}`);
    continue;
  }
  if (k.maxPris && a.pris && a.pris > k.maxPris) continue;
  if (k.minRum && a.rum && a.rum < k.minRum) continue;
  if (k.minBoarea && a.boarea && a.boarea < k.minBoarea) continue;
  if (k.minTomtarea && a.tomtarea && a.tomtarea < k.minTomtarea) continue;

  const rader = [];
  let uppfyller = true;

  if (a.lat != null && a.lon != null) {
    const h = await narmasteHallplatser(a.lat, a.lon);
    if (h?.narmaste) {
      rader.push(`Hållplats: ${h.narmaste.namn} (${h.narmaste.avstand} m)`);
      if (h.narmasteTag && h.narmasteTag.namn !== h.narmaste.namn) {
        rader.push(`Tåg: ${h.narmasteTag.namn} (${h.narmasteTag.avstand} m)`);
      }
      if (h.narmaste.avstand > k.maxAvståndHållplatsM) uppfyller = false;
    } else if (h) {
      rader.push("Ingen hållplats inom 3 km");
      uppfyller = false;
    }

    const n = await naturInfo(a.lat, a.lon);
    if (n) {
      rader.push(
        `Vatten: ${n.vattenM != null ? "~" + n.vattenM + " m" : "> 1,5 km"} · ` +
          `Skog: ${n.skogM != null ? "~" + n.skogM + " m" : "> 1,5 km"} · ` +
          `Grannar (300 m): ${n.grannar}`
      );
      const vattenOk = n.vattenM != null && n.vattenM <= k.maxAvståndVattenM;
      const skogOk = n.skogM != null && n.skogM <= k.maxAvståndSkogM;
      // "något" = vatten eller skog räcker, "båda" = båda krävs, "inget" = inget krav
      const krav = k.kravNatur ?? (k.kravVattenEllerSkog === false ? "inget" : "något");
      if (krav === "något" && !vattenOk && !skogOk) uppfyller = false;
      if (krav === "båda" && !(vattenOk && skogOk)) uppfyller = false;
      if (n.grannar > k.maxGrannarInom300m) uppfyller = false;
    }
    await paus(1500); // var snäll mot Overpass gratis-API:t
  } else {
    rader.push("Plats okänd – avstånden kunde inte kontrolleras");
  }

  if (config.notiser.endastTräffar && !uppfyller) {
    console.log(`  Ny men uppfyller inte kriterierna: ${a.adress}`);
    continue;
  }

  traffar++;
  const pris = a.pris ? `${a.pris.toLocaleString("sv-SE")} kr` : "";
  const fakta = [a.rum && `${a.rum} rum`, a.boarea && `${a.boarea} m²`, a.tomtarea && `tomt ${a.tomtarea} m²`]
    .filter(Boolean)
    .join(", ");
  const typNamn = a.typ ? a.typ.charAt(0).toUpperCase() + a.typ.slice(1) : "Bostad";
  await notis({
    titel: [uppfyller ? "Träff:" : "Ny:", typNamn, a.omrade ? `i ${a.omrade}` : "", pris ? `– ${pris}` : ""]
      .filter(Boolean).join(" "),
    meddelande: [a.adress, fakta, ...rader, `via ${a.kalla}`].filter(Boolean).join("\n"),
    lank: a.url,
  });
  console.log(`  Notis skickad: ${a.adress} (${a.kalla})`);
}

sparaSedda(sedda);

if (forstaKorning) {
  console.log(`\nFörsta körningen: ${nya} befintliga annonser sparade som "sedda". Från och med nästa körning får du notiser om allt nytt.`);
} else {
  console.log(`\nKlart. ${nya} nya annonser, ${traffar} notiser skickade.`);
}

// ---- Testläge ----
async function korTest() {
  console.log("=== TESTLÄGE – låtsashus utanför Norrtälje ===\n");
  const hus = { adress: "Testvägen 1", ort: "Norrtälje", lat: 59.7462, lon: 18.7734 };
  const rader = [];

  console.log("1. Hållplatskoll (Trafiklab ResRobot)...");
  if (harResrobotNyckel()) {
    const h = await narmasteHallplatser(hus.lat, hus.lon);
    if (h?.narmaste) {
      rader.push(`Hållplats: ${h.narmaste.namn} (${h.narmaste.avstand} m)`);
      console.log(`   ✔ Närmaste hållplats: ${h.narmaste.namn}, ${h.narmaste.avstand} m`);
    } else {
      console.log("   ✘ Fick inget svar från ResRobot – kontrollera nyckeln.");
    }
  } else {
    rader.push("(ResRobot-nyckel saknas ännu)");
    console.log("   ⏭ Hoppar över – RESROBOT_API_KEY är inte satt.");
  }

  console.log("2. Natur-koll (OpenStreetMap)...");
  const n = await naturInfo(hus.lat, hus.lon);
  if (n) {
    rader.push(`Vatten: ~${n.vattenM} m · Skog: ~${n.skogM} m · Grannar: ${n.grannar}`);
    console.log(`   ✔ Vatten ~${n.vattenM} m, skog ~${n.skogM} m, ${n.grannar} grannbyggnader`);
  } else {
    console.log("   ✘ Overpass svarade inte – testet fortsätter ändå.");
  }

  console.log("3. Mejlkälla (IMAP)...");
  if (harImap()) {
    try {
      const lista = await hamtaMailAnnonser();
      console.log(`   ✔ Inkorgen nådd – ${lista.length} annonser i olästa bevakningsmejl.`);
    } catch (err) {
      console.log(`   ✘ Kunde inte läsa inkorgen: ${err.message}`);
    }
  } else {
    console.log("   ⏭ Hoppar över – IMAP_USER/IMAP_PASSWORD är inte satta.");
  }

  console.log("4. Skickar testnotis (ntfy)...");
  await notis({
    titel: "Testnotis från Bostadsvakt",
    meddelande: [`${hus.adress}, ${hus.ort} (låtsashus)`, ...rader, "Allt fungerar!"].join("\n"),
    lank: "https://github.com/mathiasmholm/bostadsvakt",
  });
  console.log(
    process.env.NTFY_TOPIC
      ? "   ✔ Skickad! Kolla din mobil."
      : "   ⏭ NTFY_TOPIC saknas – notisen skrevs bara ut ovan."
  );
  console.log("\n=== TEST KLART ===");
}
