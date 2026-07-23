// Bostadsvakt – letar nya villor via Booli, kollar pendling (ResRobot),
// vatten/skog/grannar (OpenStreetMap) och skickar push-notiser via ntfy.
import { readFileSync } from "node:fs";
import { harBooliNycklar, sokAnnonser } from "./booli.js";
import { narmasteHallplatser, harResrobotNyckel } from "./transit.js";
import { naturInfo } from "./nature.js";
import { notis } from "./notify.js";
import { lasSedda, sparaSedda } from "./state.js";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const k = config.kriterier;
const paus = (ms) => new Promise((r) => setTimeout(r, ms));

// Testläge: kör hela kedjan på ett låtsashus utan att behöva Booli-nycklar.
if (process.argv.includes("--test")) {
  await korTest();
  process.exit(0);
}

if (!harBooliNycklar()) {
  console.error(
    "Booli-nycklar saknas. Sätt miljövariablerna BOOLI_CALLER_ID och BOOLI_PRIVATE_KEY.\n" +
      "Se README.md för hur du skaffar dem (gratis via Booli)."
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

for (const sok of config.searches) {
  console.log(`\nSöker: ${sok.namn} (${k.objectType})...`);
  let annonser;
  try {
    annonser = await sokAnnonser({ q: sok.q, objectType: k.objectType });
  } catch (err) {
    console.error(`  Fel vid sökning: ${err.message}`);
    continue;
  }
  console.log(`  ${annonser.length} annonser hittade.`);

  for (const a of annonser) {
    if (sedda.has(a.id)) continue;
    sedda.add(a.id);
    nya++;

    // Vid allra första körningen markeras allt som sett utan notiser,
    // annars skulle du dränkas i pushar för gamla annonser.
    if (forstaKorning) continue;

    if (k.maxPris && a.pris && a.pris > k.maxPris) continue;

    const rader = [];
    let uppfyller = true;

    if (a.lat != null && a.lon != null) {
      const h = await narmasteHallplatser(a.lat, a.lon);
      if (h?.narmaste) {
        rader.push(`🚏 ${h.narmaste.namn} (${h.narmaste.avstand} m)`);
        if (h.narmasteTag && h.narmasteTag.namn !== h.narmaste.namn) {
          rader.push(`🚆 ${h.narmasteTag.namn} (${h.narmasteTag.avstand} m)`);
        }
        if (h.narmaste.avstand > k.maxAvståndHållplatsM) uppfyller = false;
      } else if (h) {
        rader.push("🚏 Ingen hållplats inom 3 km");
        uppfyller = false;
      }

      const n = await naturInfo(a.lat, a.lon);
      if (n) {
        rader.push(
          `🌊 Vatten: ${n.vattenM != null ? "~" + n.vattenM + " m" : "> 1,5 km"}  ` +
            `🌲 Skog: ${n.skogM != null ? "~" + n.skogM + " m" : "> 1,5 km"}  ` +
            `🏘️ Grannar (300 m): ${n.grannar}`
        );
        const vattenOk = n.vattenM != null && n.vattenM <= k.maxAvståndVattenM;
        const skogOk = n.skogM != null && n.skogM <= k.maxAvståndSkogM;
        if (k.kravVattenEllerSkog && !vattenOk && !skogOk) uppfyller = false;
        if (n.grannar > k.maxGrannarInom300m) uppfyller = false;
      }
      await paus(1500); // var snäll mot Overpass gratis-API:t
    }

    if (config.notiser.endastTräffar && !uppfyller) {
      console.log(`  Ny men uppfyller inte kriterierna: ${a.adress}, ${a.ort}`);
      continue;
    }

    traffar++;
    const pris = a.pris ? `${a.pris.toLocaleString("sv-SE")} kr` : "Pris saknas";
    const fakta = [a.rum && `${a.rum} rum`, a.boarea && `${a.boarea} m²`, a.tomtarea && `tomt ${a.tomtarea} m²`]
      .filter(Boolean)
      .join(", ");
    await notis({
      titel: `${uppfyller ? "🎯 " : ""}${a.typ || "Villa"} i ${a.ort || sok.namn} – ${pris}`,
      meddelande: [`📍 ${a.adress}`, fakta, ...rader].filter(Boolean).join("\n"),
      lank: a.url,
    });
    console.log(`  ✔ Notis skickad: ${a.adress}, ${a.ort}`);
  }
}

sparaSedda(sedda);

if (forstaKorning) {
  console.log(`\nFörsta körningen: ${nya} befintliga annonser sparade som "sedda". Från och med nästa körning får du notiser om allt nytt.`);
} else {
  console.log(`\nKlart. ${nya} nya annonser, ${traffar} notiser skickade.`);
}

async function korTest() {
  console.log("=== TESTLÄGE – låtsashus utanför Norrtälje ===\n");
  const hus = { adress: "Testvägen 1", ort: "Norrtälje", lat: 59.7462, lon: 18.7734 };
  const rader = [];

  console.log("1. Hållplatskoll (Trafiklab ResRobot)...");
  if (harResrobotNyckel()) {
    const h = await narmasteHallplatser(hus.lat, hus.lon);
    if (h?.narmaste) {
      rader.push(`🚏 ${h.narmaste.namn} (${h.narmaste.avstand} m)`);
      console.log(`   ✔ Närmaste hållplats: ${h.narmaste.namn}, ${h.narmaste.avstand} m`);
    } else {
      console.log("   ✘ Fick inget svar från ResRobot – kontrollera nyckeln.");
    }
  } else {
    rader.push("🚏 (ResRobot-nyckel saknas ännu)");
    console.log("   ⏭ Hoppar över – RESROBOT_API_KEY är inte satt.");
  }

  console.log("2. Natur-koll (OpenStreetMap)...");
  const n = await naturInfo(hus.lat, hus.lon);
  if (n) {
    rader.push(`🌊 Vatten: ~${n.vattenM} m  🌲 Skog: ~${n.skogM} m  🏘️ Grannar: ${n.grannar}`);
    console.log(`   ✔ Vatten ~${n.vattenM} m, skog ~${n.skogM} m, ${n.grannar} grannbyggnader`);
  } else {
    console.log("   ✘ Overpass svarade inte – testet fortsätter ändå.");
  }

  console.log("3. Skickar testnotis (ntfy)...");
  await notis({
    titel: "✅ Testnotis från Bostadsvakt",
    meddelande: [`📍 ${hus.adress}, ${hus.ort} (låtsashus)`, ...rader, "Allt fungerar! 🎉"].join("\n"),
    lank: "https://github.com/mathiasmholm/bostadsvakt",
  });
  console.log(
    process.env.NTFY_TOPIC
      ? "   ✔ Skickad! Kolla din mobil."
      : "   ⏭ NTFY_TOPIC saknas – notisen skrevs bara ut ovan."
  );
  console.log("\n=== TEST KLART ===");
}
