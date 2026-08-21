// Bostadsvakt – letar nya bostäder via Booli-API och/eller bevakningsmejl
// (Hemnet + Booli), kollar pendling (ResRobot), vatten/skog/grannar
// (OpenStreetMap) och skickar push-notiser via en Home Assistant-webhook.
import { readFileSync } from "node:fs";
import { harBooliNycklar, sokAnnonser } from "./booli.js";
import { harImap, hamtaMailAnnonser } from "./mailsource.js";
import { narmasteHallplatser, resaTillStockholm, resaTillAndraMalet, turtathet, bilTillHallplats, harResrobotNyckel } from "./transit.js";
import { geokoda, slaUppPlats } from "./geocode.js";
import { myndighetForKommun, visaKommun } from "./lan.js";
import { naturInfo } from "./nature.js";
import { notis } from "./notify.js";
import { lasSedda, sparaSedda } from "./state.js";
import { lasTraffar, sparaTraffar } from "./matches.js";
import { beraknaMatchning } from "./score.js";
import { skrivBedomning } from "./ai.js";
import { lasSlutpriser, sparaSlutpriser, jamforPris } from "./slutpriser.js";
import { berikaFranBooli, arBooliAnnons } from "./annonsberikning.js";
import { harRad } from "./ekonomi.js";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const k = config.kriterier;
const paus = (ms) => new Promise((r) => setTimeout(r, ms));
const normTyp = (s) => (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const fmtTid = (min) => (min >= 60 ? `${Math.floor(min / 60)} tim ${min % 60} min` : `${min} min`);

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

// Andra pendlingsmål (t.ex. en arbetsplats): valfritt, geokodas en gång här
// och återanvänds för alla hus i den här körningen – adressen ändras ju
// inte hus för hus.
let andraMalKoord = null;
let andraMalMyndighet = null;
if (harResrobotNyckel() && k.andraMal?.adress) {
  andraMalKoord = await geokoda(k.andraMal.adress, { omraden: config.searches.map((s) => s.namn) });
  if (!andraMalKoord) {
    console.warn(`  Kunde inte geokoda andra pendlingsmålet "${k.andraMal.adress}" – hoppas över.`);
  } else {
    // Målets län avgör (tillsammans med husets) om resan dit korsar en
    // länsgräns och därmed kräver två biljetter – se lan.js.
    andraMalMyndighet = myndighetForKommun(andraMalKoord.kommun);
  }
}

const sedda = lasSedda();
const forstaKorning = sedda.size === 0;
const traffarLagrade = new Map(lasTraffar().map((t) => [t.id, t]));
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
    const { annonser: lista, slutpriser: nyaSlutpriser } = await hamtaMailAnnonser(config.searches.map((s) => s.namn));
    console.log(`  ${lista.length} annonser i mejlen, ${nyaSlutpriser.length} nya slutpriser.`);
    annonser.push(...lista);
    if (nyaSlutpriser.length) sparaSlutpriser([...lasSlutpriser(), ...nyaSlutpriser]);
  } catch (err) {
    console.error(`  Kunde inte läsa inkorgen: ${err.message}`);
  }
}

// ---- Slå ihop dubbletter mellan källor ----
// Hemnet och Booli ger samma hus olika id (hemnet-XXXX / booli-XXXX), så ett
// id-baserat "redan sedd"-test (som sedda/traffarLagrade gör) fångar inte när
// samma hus dyker upp via båda. Matcha på normaliserad adress+område istället:
// dels mot redan sparade hus (annat körnings-id men samma adress), dels mot
// tidigare annonser inom samma körning.
const normAdr = (s) => (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();
const adressNyckel = (a) => `${normAdr(a.adress)}|${normAdr(a.omrade)}`;

const kandaAdresser = new Map();
for (const t of traffarLagrade.values()) {
  if (t.adress) kandaAdresser.set(adressNyckel(t), t.id);
}

const annonserUnika = [];
for (const a of annonser) {
  if (!a.adress) { annonserUnika.push(a); continue; } // inget att matcha mot
  const nyckel = adressNyckel(a);
  const befintligtId = kandaAdresser.get(nyckel);
  if (befintligtId && befintligtId !== a.id) {
    console.log(`  Dubblett: "${a.adress}" (${a.id}) matchar redan känt hus ${befintligtId} – hoppar över.`);
    continue;
  }
  kandaAdresser.set(nyckel, a.id);
  annonserUnika.push(a);
}

// ---- Bedöm och notifiera ----
const tillatnaTyper = k.objectType.split(",").map(normTyp);
const slutprisData = lasSlutpriser(); // läses en gång, inkl. ev. nya poster ovan

for (const a of annonserUnika) {
  if (sedda.has(a.id)) continue;
  sedda.add(a.id);
  nya++;

  // Vid allra första API-körningen markeras hela utbudet som sett utan
  // notiser – mejlkällan innehåller däremot bara nyheter och notifierar alltid.
  if (forstaKorning && a.bulk) continue;

  try {
    await behandlaAnnons(a);
  } catch (err) {
    // Huset är redan markerat "sett" (annars skulle det bevakas om och om
    // igen), men ett fel här ska aldrig få hela körningen att krascha och
    // tysta resten av annonserna – logga och gå vidare.
    console.error(`  Fel vid bearbetning av ${a.id} (${a.adress || "adress saknas"}): ${err.message}`);
  }
}

// `tyst` används av rättningsomgången nedan: samma analys, men utan notis –
// ett hus som råkade ligga fel på kartan sedan i somras ska inte pusha ut sig
// själv igen bara för att nålen flyttades till rätt ställe.
async function behandlaAnnons(a, { tyst = false } = {}) {
  // Hårda filter: hustyp, pris, rum och yta. Hus utanför dessa visas inte
  // alls (bara uteslutna om värdet är känt). Läge/natur avgör Träff nedan.
  if (a.typ && !tillatnaTyper.includes(normTyp(a.typ))) {
    console.log(`  Utanför filter (hustyp ${a.typ}) [${a.id}]: ${a.adress}`);
    return;
  }
  if (k.maxPris && a.pris && a.pris > k.maxPris) {
    console.log(`  Utanför filter (pris ${a.pris} > ${k.maxPris}) [${a.id}]: ${a.adress}`);
    return;
  }
  if (k.minRum && a.rum && a.rum < k.minRum) {
    console.log(`  Utanför filter (rum ${a.rum} < ${k.minRum}) [${a.id}]: ${a.adress}`);
    return;
  }
  if (k.minBoarea && a.boarea && a.boarea < k.minBoarea) {
    console.log(`  Utanför filter (boarea ${a.boarea} < ${k.minBoarea}) [${a.id}]: ${a.adress}`);
    return;
  }
  if (k.minTomtarea && a.tomtarea && a.tomtarea < k.minTomtarea) {
    console.log(`  Utanför filter (tomt ${a.tomtarea} < ${k.minTomtarea}) [${a.id}]: ${a.adress}`);
    return;
  }

  const pendling = [];
  const omgivning = [];
  const noteringar = [];
  const matt = {};
  let uppfyller = true;
  let turer = null; // turtäthet från närmaste hållplats, se nedan
  let bilAlternativ = null; // bil till en hållplats som går att pendla från

  // Vilken kommun – och därmed vilket trafikbolag/biljettsystem – gäller här?
  // Mejlkällan har normalt redan verifierat kommunen vid geokodningen. Booli-
  // annonser kommer med färdiga koordinater utan att ha passerat geokodaren,
  // så för dem slår vi upp kommunen baklänges. Utan det här steget vet vi inte
  // om huset ligger i SL- eller UL-land, och då blir biljettbeskedet en gissning
  // – vilket är precis vad som gav "UL + SJ" för hus i Norrtälje.
  let myndighet = myndighetForKommun(a.kommun);
  let kommunNamn = a.kommun ? visaKommun(a.kommun) : "";
  if (!myndighet && a.lat != null && a.lon != null) {
    const plats = await slaUppPlats(a.lat, a.lon);
    if (plats) {
      myndighet = myndighetForKommun(plats.kommun);
      kommunNamn = plats.kommunNamn;
    }
  }

  if (a.lat != null && a.lon != null) {
    if (kommunNamn && myndighet) {
      pendling.push(`Läge: ${kommunNamn} kommun (${myndighet.lan}) – ${myndighet.namn}-område`);
    }

    const h = await narmasteHallplatser(a.lat, a.lon, myndighet);
    if (h?.narmaste) {
      pendling.push(`Hållplats: ${h.narmaste.namn} · ${h.narmaste.avstand} m`);
      if (h.narmasteTag && h.narmasteTag.namn !== h.narmaste.namn) {
        pendling.push(`Tåg: ${h.narmasteTag.namn} · ${h.narmasteTag.avstand} m`);
      }
      matt.hallplatsAvstand = h.narmaste.avstand;
      if (h.narmaste.avstand > k.maxAvståndHållplatsM) uppfyller = false;

      // Hur ofta går det egentligen härifrån? Att det FINNS en hållplats
      // säger ingenting – i Norrtäljes ytterområden kan närmaste "hållplats"
      // vara en punkt som bara trafikeras av anropsstyrd trafik man måste
      // ringa och beställa. Det syns nu istället för att gömmas.
      // h.sl[0] är närmaste SL-hållplats (bara i SL-land) och används som
      // extra kontroll av just närtrafiken – se sl.js.
      turer = await turtathet({ ...h.narmaste, slId: h.sl?.[0]?.id ?? null }, myndighet);
      if (turer) {
        const spann = turer.forsta && turer.sista ? ` (${turer.forsta}–${turer.sista})` : "";
        pendling.push(`Turtäthet: ${turer.text}${spann}`);
        matt.turtathetAvgangar = turer.antal;
        for (const text of turer.bokning) pendling.push(`⚠ ${text}`);

        // Går det inte att pendla från dörren – anropsstyrd trafik eller ingen
        // trafik alls – betyder det inte att huset är omöjligt. De flesta här
        // kör bil till en riktig hållplats och ställer bilen där. Utan det här
        // steget stod det bara "ingen trafik" och huset såg sämre ut än det är.
        if (turer.kraverBokning || turer.antal < 6) {
          bilAlternativ = await bilTillHallplats(a.lat, a.lon, myndighet, new Set([h.narmaste.id]));
          if (bilAlternativ) {
            const b = bilAlternativ;
            const cirka = b.bilUppskattad ? "ca " : "";
            pendling.push(
              `Bil till ${b.hallplats}: ${cirka}${b.bilMin} min (${b.bilKm} km)` +
                (b.arTagstation ? " · tågstation" : "")
            );
            if (b.parkeringstext) pendling.push(`Parkering: ${b.parkeringstext}`);
            else pendling.push("Parkering: ingen hittad i OpenStreetMap vid hållplatsen");
            pendling.push(`Därifrån: ${b.turtathet.text}`);
            if (b.totaltTillStockholmMin != null) {
              pendling.push(`Totalt till Stockholm C med bil + kollektivt: ca ${fmtTid(b.totaltTillStockholmMin)}`);
            }
            // Poängen ska spegla hur man FAKTISKT skulle pendla. Turtätheten
            // räknas därför på hållplatsen man kör till, inte på den vid dörren
            // som ingen kan använda – men körtiden kostar, se score.js.
            matt.turtathetAvgangar = b.turtathet.antal;
            matt.bilTillHallplatsMin = b.bilMin;
            if (b.totaltTillStockholmMin != null) matt.restidMin = b.totaltTillStockholmMin;
          } else {
            pendling.push("⚠ Hittade ingen hållplats inom rimligt bilavstånd med regelbunden trafik");
          }
        }
      }
    } else if (h) {
      pendling.push("Ingen hållplats inom 3 km");
      uppfyller = false;
    }

    const resa = await resaTillStockholm(a.lat, a.lon, myndighet);
    if (resa) {
      // Hårt filter precis som pris/rum/yta: en resa på över maxRestid är
      // inte "en svag länk" man ändå vill se, det är en dealbreaker – huset
      // ska inte synas i flödet alls. Vet vi inte restiden (resa === null,
      // t.ex. ResRobot saknar ruttdata för platsen) utesluts inget, för att
      // inte gömma hus där vi bara råkar sakna data.
      if (k.maxRestidStockholmMin && resa.restidMin > k.maxRestidStockholmMin) {
        console.log(`  Utanför filter (restid ${resa.restidMin} min > ${k.maxRestidStockholmMin} min) [${a.id}]: ${a.adress}`);
        return;
      }
      const byten = resa.byten === 0 ? "utan byte" : `${resa.byten} byte${resa.byten > 1 ? "n" : ""}`;
      pendling.push(`Stockholm C: ca ${fmtTid(resa.restidMin)} · ${byten}`);
      matt.restidMin = resa.restidMin;

      // Biljettbeskedet utgår från LÄNEN, inte från hur många bolagsnamn som
      // råkar nämnas i resan. Byte mellan SL-buss och pendeltåg ger två
      // operatörsnamn men är fortfarande en enda SL-biljett; det som faktiskt
      // kostar en extra biljett är att korsa länsgränsen Uppsala–Stockholm.
      if (resa.biljett) {
        pendling.push(resa.biljett.tvaBiljetter ? `⚠ ${resa.biljett.text}` : resa.biljett.text);
      }
      // Operatörerna är numera ren upplysning, inte en varning.
      if (resa.operatorer.length) pendling.push(`Trafikeras av: ${resa.operatorer.join(", ")}`);
      for (const text of resa.bokning) pendling.push(`⚠ ${text}`);
    }

    // Andra pendlingsmålet är bara informativt – inget hårt filter, ingen
    // "dealbreaker"-logik som för Stockholm ovan.
    if (andraMalKoord) {
      const resaAndra = await resaTillAndraMalet(
        a.lat, a.lon, andraMalKoord.lat, andraMalKoord.lon, myndighet, andraMalMyndighet
      );
      if (resaAndra) {
        pendling.push(`${k.andraMal.namn || "Andra målet"}: ca ${fmtTid(resaAndra.restidMin)}`);
        matt.restidAndraMalMin = resaAndra.restidMin;
        if (resaAndra.biljett?.tvaBiljetter) pendling.push(`⚠ ${k.andraMal.namn || "Andra målet"}: ${resaAndra.biljett.text}`);
      }
    }

    const n = await naturInfo(a.lat, a.lon);
    if (n) {
      omgivning.push(
        `Vatten: ${n.vattenM != null ? "ca " + n.vattenM + " m" : "över 1,5 km"} · ` +
          `Skog: ${n.skogM != null ? "ca " + n.skogM + " m" : "över 1,5 km"}`
      );
      omgivning.push(`Grannar inom 300 m: ${n.grannar}`);
      matt.vattenM = n.vattenM;
      matt.skogM = n.skogM;
      matt.grannar = n.grannar;
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
    noteringar.push("Plats okänd – avstånden kunde inte kontrolleras");
    uppfyller = false;
  }
  // Matchningen returnerar numera hela uträkningen, inte bara siffran: varje
  // faktors mätvärde, delpoäng, vikt och bidrag. Det är det som gör att man
  // kan svara på "varför är det här huset 80 och det där 20?" – se score.js.
  const matchning = beraknaMatchning(k, matt);
  const poang = matchning.poang;

  // Prisjämförelse: hur ligger huset till mot nyligen sålda hus i samma
  // område (kr/m²)? Kräver att slutpriser-bevakningen samlat in tillräckligt
  // med jämförelsepunkter – annars null och notisen visar bara priset som förr.
  const prisJmforelse = jamforPris(
    { pris: a.pris, boarea: a.boarea, ort: a.omrade || a.ort, typ: a.typ },
    slutprisData
  );
  const prisRader = prisJmforelse
    ? [
        `${prisJmforelse.husKvm.toLocaleString("sv-SE")} kr/m² · områdessnitt ${prisJmforelse.snittKvm.toLocaleString("sv-SE")} kr/m² ` +
          `(${prisJmforelse.antalJamforelser} sålda jämförelser)`,
        prisJmforelse.diffProcent <= 0
          ? `${Math.abs(prisJmforelse.diffProcent)}% under snittpriset i området`
          : `${prisJmforelse.diffProcent}% över snittpriset i området`,
      ]
    : [];

  // Driftskostnad och byggår finns aldrig i bevakningsmejlen – bara på
  // Boolis egen annonssida. Anropas för alla hus (funktionen avgör själv om
  // det är en Booli-annons); en paus efteråt bara när ett anrop faktiskt
  // gjordes, av samma artighetsskäl som paus(1500) efter Overpass nedan.
  const berikning = await berikaFranBooli(a);
  if (arBooliAnnons(a)) await paus(800);

  // Har hushållet råd? "okänt" (inte ett gissat nej) tills hushall är ifyllt
  // i config.json – se ekonomi.js. Räknas på alla hus, oavsett läge, eftersom
  // den bara behöver pris och boarea.
  const ekonomi = harRad({
    pris: a.pris,
    boarea: a.boarea,
    driftskostnadKandKrManad: berikning.driftskostnadManad,
    hushall: config.hushall,
  });
  const ekonomiRader =
    ekonomi.verdikt !== "okant"
      ? [
          `Lån: ${ekonomi.lan.toLocaleString("sv-SE")} kr (${ekonomi.belaningsgradProcent}% belåningsgrad, ${ekonomi.amorteringsprocent}% amortering/år)`,
          `Engångskostnad: ${ekonomi.engangskostnad.toLocaleString("sv-SE")} kr (lagfart + pantbrev)`,
          `Månadskostnad: ca ${ekonomi.manad.total.toLocaleString("sv-SE")} kr idag, ca ${ekonomi.manadStress.total.toLocaleString("sv-SE")} kr stresstestat (${ekonomi.antaganden.kalkylranta}% ränta)`,
          ekonomi.verdikt === "ja" ? `✓ Har råd: ${ekonomi.forklaring}` : `⚠ Har troligen inte råd: ${ekonomi.forklaring}`,
        ]
      : [];

  const pris = a.pris ? `${a.pris.toLocaleString("sv-SE")} kr` : "";
  const typNamn = a.typ ? a.typ.charAt(0).toUpperCase() + a.typ.slice(1) : "Bostad";
  const fakta = [typNamn, a.rum && `${a.rum} rum`, a.boarea && `${a.boarea} m²`, a.tomtarea && `tomt ${a.tomtarea} m²`]
    .filter(Boolean)
    .join(" · ");
  // Utan koordinater finns inget att bedöma – AI:n har då bara en
  // adress-platshållare och tomma pendling/omgivning-listor att gå på, och
  // svarar istället med ett förvirrat "jag saknar underlag, kan du skicka
  // mer info?" som ser trasigt ut i panelen. Hoppa hellre över bedömningen.
  const aiOmdome = a.lat != null
    ? await skrivBedomning({
        adress: a.adress, typ: typNamn, fakta, pris: a.pris, k, pendling, omgivning, poang, prisJmforelse,
        // AI:n får numera kommun/län, biljettläget och poängens uppdelning.
        // Utan det upprepade den bara pendlingsraderna – och när de sa
        // "UL + SJ" för ett hus i Norrtälje skrev den vidare det felet.
        kommun: kommunNamn, myndighet, matchning, turtathet: turer, ekonomi,
      })
    : null;

  // Prisfall: jämför mot priset huset hade förra gången vi sparade det.
  // Sjunker det, spara vem/vad det sjönk från – annars behåll en ev. tidigare
  // sänkning så den inte försvinner bara för att priset står stilla en körning.
  const tidigareHus = traffarLagrade.get(a.id);
  const prisSankning =
    a.pris != null && tidigareHus?.pris != null && a.pris < tidigareHus.pris
      ? { fran: tidigareHus.pris, till: a.pris, tidpunkt: new Date().toISOString() }
      : (tidigareHus?.prisSankning ?? null);

  // Spara ALLA hus till flödet (Bostäder), behåll ev. panel-flaggor.
  // typ sparas tomt (inte "Bostad"-platshållaren) när hustypen är okänd –
  // annars tolkar hårdfiltret/städningen nedan "Bostad" som en riktig,
  // otillåten hustyp och huset försvinner igen trots att typen bara var
  // okänd (samma mönster som adress-fallbacken, upptäckt när de fyra
  // återställda Hemnet-husen fortfarande städades bort).
  traffarLagrade.set(a.id, {
    ...traffarLagrade.get(a.id),
    id: a.id,
    tidpunkt: new Date().toISOString(),
    kalla: a.kalla,
    typ: a.typ ? typNamn : "",
    omrade: a.omrade || a.ort || "",
    adress: a.adress,
    pris: a.pris ?? null,
    rum: a.rum ?? null,
    boarea: a.boarea ?? null,
    tomtarea: a.tomtarea ?? null,
    restidMin: matt.restidMin ?? null,
    restidAndraMalMin: matt.restidAndraMalMin ?? null,
    prisJmforelse,
    prisSankning,
    // Byggår kommer bara från Boolis annonssida (se annonsberikning.js) –
    // null för Hemnet-hus, en ärlig lucka snarare än en gissning.
    byggar: berikning.byggar,
    // Hela uträkningen, för den dag en yta vill visa den strukturerat...
    ekonomi: ekonomi.verdikt !== "okant" ? ekonomi : null,
    // ...och samma färdigformaterade rader som notisen använder, i samma
    // form som pendling/omgivning redan har. Alva slår redan ihop de två till
    // en enda lista och skriver ut varje rad – lägga till den här listan i den
    // sammanslagningen är hela ändringen som behövs där. Nya eller omskrivna
    // rader från en framtida push hit dyker sedan upp i Alva utan att någon
    // rör Alva-koden igen.
    ekonomiRader,
    aiOmdome,
    url: a.url,
    bild: a.bild ?? null,
    lat: a.lat ?? null,
    lon: a.lon ?? null,
    // Kommun/län/myndighet sparas så panelen kan visa var huset FAKTISKT
    // ligger och vilket biljettsystem som gäller, utan att gissa av nålen.
    kommun: kommunNamn || null,
    lan: myndighet?.lan ?? null,
    myndighet: myndighet?.kod ?? null,
    // "hus" | "gata" | "ort" – hur exakt kartnålen är. En ortsnivåträff kan
    // ligga kilometervis fel och ska inte se lika säker ut i panelen som en
    // husnummerträff.
    platsPrecision: a.platsPrecision ?? null,
    turtathet: turer
      ? { antal: turer.antal, klass: turer.klass, text: turer.text,
          forsta: turer.forsta, sista: turer.sista,
          kraverBokning: turer.kraverBokning, bokning: turer.bokning }
      : null,
    // Bil till en hållplats som går att pendla från, när den vid dörren inte
    // duger. Null för de allra flesta hus – det här är undantagsfallet.
    bilTillHallplats: bilAlternativ,
    pendling,
    omgivning,
    uppfyller,
    poang,
    // Hela uträkningen bakom poängen, så panelen kan visa varför.
    matchning,
  });

  if (tyst) {
    console.log(`  Omvärderat [${a.id}]: ${a.adress} → ${kommunNamn || "okänd kommun"}, matchning ${poang ?? "–"}/100`);
    return;
  }

  // Notis: bara för träffar (eller för alla om så valts), aldrig på första
  // körningen eller för Hemnets egna rekommendationer ("Hemnet Max") – de
  // är inte nya sökträffar, bara tips, och ska synas i galleriet utan att
  // trigga en push varje gång Hemnet råkar nämna dem igen.
  if (forstaKorning || a.kalla === "Hemnet Max" || (config.notiser.endastTräffar && !uppfyller)) {
    const etikett = a.kalla === "Hemnet Max" ? "Tips" : uppfyller ? "Träff" : "Ny";
    console.log(`  ${etikett} sparad utan notis [${a.id}]: ${a.adress}`);
    return;
  }

  traffar++;
  const sektion = (rubrik, rader) => (rader.length ? ["", rubrik, ...rader] : []);
  await notis({
    titel: [uppfyller ? "Träff:" : "Ny:", typNamn, a.omrade ? `i ${a.omrade}` : "", pris ? `· ${pris}` : ""]
      .filter(Boolean).join(" "),
    meddelande: [
      a.adress,
      fakta,
      ...sektion("PRIS", prisRader),
      ...sektion("EKONOMI", ekonomiRader),
      ...sektion("PENDLING", pendling),
      ...sektion("OMGIVNING", omgivning),
      ...sektion("OBS", noteringar),
      "",
      poang != null ? `Matchning: ${poang}/100` : "",
      // Kort redovisning direkt i notisen – annars är siffran bara en siffra.
      ...(matchning.delar.length
        ? [matchning.delar.map((d) => `${d.namn} ${d.delpoang}/100`).join(" · ")]
        : []),
      ...(aiOmdome ? ["", aiOmdome] : []),
      uppfyller ? "✓ Uppfyller alla dina krav" : "Uppfyller inte alla krav",
      `via ${a.kalla}`,
    ].join("\n"),
    lank: a.url,
    lat: a.lat,
    lon: a.lon,
    prioritet: uppfyller ? 4 : 3,
    bild: a.bild,
  });
  console.log(`  Notis skickad: ${a.adress} (${a.kalla})`);
}

// ---- Rätta redan sparade hus med overifierad plats ----
// De hus som sparades innan geokodningen började verifiera kommunen ligger
// kvar med sina felaktiga koordinater, och de bearbetas aldrig om: deras id
// står i `sedda`, och mejlen de kom ur är sedan länge lästa. Utan det här
// steget syns alltså fixen bara på NYA hus, medan alla gamla nålar fortsätter
// peka fel – och det var just de felplacerade husen som var problemet.
//
// Ett hus känns igen på att det saknar `kommun` (fältet fanns inte förut).
// Antalet per körning är begränsat för att hålla körtiden nere och vara snäll
// mot gratis-API:erna; resten tas nästa körning tills alla är genomgångna.
const MAX_RATTADE_PER_KORNING = 15;

async function rattaPlatser() {
  const kandidater = [...traffarLagrade.values()]
    .filter((t) => !t.kommun && t.adress && (t.platsForsok ?? 0) < 3)
    .slice(0, MAX_RATTADE_PER_KORNING);
  if (!kandidater.length) return;

  console.log(`\nRättar plats för ${kandidater.length} tidigare sparade hus (overifierade koordinater)...`);
  let rattade = 0;
  let rensade = 0;

  for (const t of kandidater) {
    try {
      // `omrade` på ett sparat hus är annonsens ort ("Väddö", "Skebobruk").
      // Går den att slå upp till en kommun låses uppslaget till just den.
      const pos = await geokoda(t.adress, {
        ort: t.omrade,
        omraden: config.searches.map((s) => s.namn),
      });

      if (!pos) {
        // Ingen verifierbar plats: nollställ koordinaterna hellre än att låta
        // en felaktig nål stå kvar. Panelen visar då "Plats okänd", vilket är
        // ärligare än ett hus utplacerat i fel kommun.
        traffarLagrade.set(t.id, {
          ...t,
          lat: null, lon: null, platsPrecision: null,
          platsForsok: (t.platsForsok ?? 0) + 1,
        });
        rensade++;
        console.log(`  Ingen verifierad plats för "${t.adress}" (${t.omrade || "okänt område"}) – nålen tas bort.`);
        continue;
      }

      const flyttadKm = t.lat != null
        ? Math.round(avstandKm(t.lat, t.lon, pos.lat, pos.lon))
        : null;

      // Kör hela analysen igen från den RÄTTA platsen. Hållplats, turtäthet,
      // restid, natur, grannar och matchning mättes ju alla på fel ställe.
      await behandlaAnnons({
        id: t.id, kalla: t.kalla, typ: t.typ, omrade: t.omrade, adress: t.adress,
        pris: t.pris, rum: t.rum, boarea: t.boarea, tomtarea: t.tomtarea,
        url: t.url, bild: t.bild,
        lat: pos.lat, lon: pos.lon,
        kommun: pos.kommunNamn, lan: pos.lan, myndighet: pos.myndighet,
        platsPrecision: pos.precision,
      }, { tyst: true });

      // behandlaAnnons kan avbryta tidigt (hårt filter på hustyp/pris/restid)
      // och då skrivs ingen ny post. Utan räknaren nedan skulle ett sådant hus
      // provas om varje körning och äta upp budgeten för de andra.
      if (!traffarLagrade.get(t.id)?.kommun) {
        traffarLagrade.set(t.id, { ...traffarLagrade.get(t.id), platsForsok: (t.platsForsok ?? 0) + 1 });
        console.log(`  "${t.adress}" föll på ett hårt filter vid omvärderingen – lämnas orörd.`);
        continue;
      }

      rattade++;
      if (flyttadKm != null && flyttadKm >= 1) {
        console.log(`  Flyttad ${flyttadKm} km: "${t.adress}" → ${pos.kommunNamn} kommun (${pos.myndighet}-område).`);
      }
    } catch (err) {
      console.error(`  Kunde inte rätta ${t.id} (${t.adress}): ${err.message}`);
      traffarLagrade.set(t.id, { ...t, platsForsok: (t.platsForsok ?? 0) + 1 });
    }
  }

  const kvar = [...traffarLagrade.values()].filter((t) => !t.kommun && t.adress && (t.platsForsok ?? 0) < 3).length;
  console.log(`  ${rattade} hus omvärderade, ${rensade} utan verifierbar plats. ${kvar} kvar till nästa körning.`);
}

// Grovt avstånd i km, bara för loggraden om hur långt ett hus flyttades.
function avstandKm(lat1, lon1, lat2, lon2) {
  const R = (d) => (d * Math.PI) / 180;
  const dLat = R(lat2 - lat1), dLon = R(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(R(lat1)) * Math.cos(R(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

await rattaPlatser();

// Städa flödet: ta bort tidigare sparade hus som numera ligger utanför de
// hårda filtren (t.ex. om maxpris sänkts) så listan alltid speglar kraven.
const antalForeStad = traffarLagrade.size;
for (const [id, t] of traffarLagrade) {
  const utanfor =
    (t.typ && !tillatnaTyper.includes(normTyp(t.typ))) ||
    (k.maxPris && t.pris && t.pris > k.maxPris) ||
    (k.minRum && t.rum && t.rum < k.minRum) ||
    (k.minBoarea && t.boarea && t.boarea < k.minBoarea) ||
    (k.minTomtarea && t.tomtarea && t.tomtarea < k.minTomtarea) ||
    (k.maxRestidStockholmMin && t.restidMin != null && t.restidMin > k.maxRestidStockholmMin);
  if (utanfor) {
    console.log(`  Städat bort ur flödet (utanför krav) [${id}]: ${t.adress}`);
    traffarLagrade.delete(id);
  }
}
if (traffarLagrade.size !== antalForeStad) {
  console.log(`  Flödet städat: ${antalForeStad} → ${traffarLagrade.size} hus.`);
}

sparaSedda(sedda);
sparaTraffar([...traffarLagrade.values()]);
console.log(`  Sparade ${traffarLagrade.size} hus till data/traffar.json.`);

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

  // Testhuset ligger i Norrtälje – alltså Stockholms län och SL-område.
  // Just det fallet gav tidigare "UL + SJ – kan kräva separata biljetter",
  // så testet visar nu uttryckligen vilket bolag och vilken biljett som gäller.
  console.log("1. Läge och trafikbolag...");
  const plats = await slaUppPlats(hus.lat, hus.lon);
  const myndighet = plats ? myndighetForKommun(plats.kommun) : null;
  if (myndighet) {
    rader.push(`Läge: ${plats.kommunNamn} kommun (${myndighet.lan}) – ${myndighet.namn}`);
    console.log(`   ✔ ${plats.kommunNamn} kommun, ${myndighet.lan} → ${myndighet.namn}`);
  } else {
    console.log("   ✘ Kunde inte slå upp kommunen (Nominatim svarade inte).");
  }

  console.log("2. Hållplats, turtäthet och restid (Trafiklab ResRobot + SL)...");
  if (harResrobotNyckel()) {
    const h = await narmasteHallplatser(hus.lat, hus.lon, myndighet);
    if (h?.narmaste) {
      rader.push(`Hållplats: ${h.narmaste.namn} (${h.narmaste.avstand} m)`);
      console.log(`   ✔ Närmaste hållplats: ${h.narmaste.namn}, ${h.narmaste.avstand} m`);

      const turer = await turtathet({ ...h.narmaste, slId: h.sl?.[0]?.id ?? null }, myndighet);
      if (turer) {
        rader.push(`Turtäthet: ${turer.text}`);
        console.log(`   ✔ ${turer.text}${turer.forsta ? ` (${turer.forsta}–${turer.sista})` : ""}`);
        for (const b of turer.bokning) console.log(`   ⚠ ${b}`);
      }

      const resa = await resaTillStockholm(hus.lat, hus.lon, myndighet);
      if (resa) {
        rader.push(`Till Stockholm C: ca ${fmtTid(resa.restidMin)}`);
        console.log(`   ✔ Restid till Stockholm C: ca ${fmtTid(resa.restidMin)} (${resa.byten} byten)`);
        if (resa.biljett) console.log(`   ✔ Biljett: ${resa.biljett.text}`);
        if (resa.operatorer.length) console.log(`   · Trafikeras av: ${resa.operatorer.join(", ")}`);
      }
    } else {
      console.log("   ✘ Fick inget svar från ResRobot – kontrollera nyckeln.");
    }
  } else {
    rader.push("(ResRobot-nyckel saknas ännu)");
    console.log("   ⏭ Hoppar över – RESROBOT_API_KEY är inte satt.");
  }

  console.log("3. Natur-koll (OpenStreetMap)...");
  const n = await naturInfo(hus.lat, hus.lon);
  if (n) {
    rader.push(`Vatten: ~${n.vattenM} m · Skog: ~${n.skogM} m · Grannar: ${n.grannar}`);
    console.log(`   ✔ Vatten ~${n.vattenM} m, skog ~${n.skogM} m, ${n.grannar} grannbyggnader`);
  } else {
    console.log("   ✘ Overpass svarade inte – testet fortsätter ändå.");
  }

  console.log("4. Mejlkälla (IMAP)...");
  if (harImap()) {
    try {
      const { annonser: lista } = await hamtaMailAnnonser(config.searches.map((s) => s.namn));
      console.log(`   ✔ Inkorgen nådd – ${lista.length} annonser i olästa bevakningsmejl.`);
    } catch (err) {
      console.log(`   ✘ Kunde inte läsa inkorgen: ${err.message}`);
    }
  } else {
    console.log("   ⏭ Hoppar över – IMAP_USER/IMAP_PASSWORD är inte satta.");
  }

  console.log("5. Skickar testnotis (HA-webhook)...");
  await notis({
    titel: "Testnotis från Bostadsvakt",
    meddelande: [`${hus.adress}, ${hus.ort} (låtsashus)`, ...rader, "✓ Allt fungerar"].join("\n"),
    lank: "https://github.com/matthewholm/bostadsvakt",
    lat: hus.lat,
    lon: hus.lon,
  });
  console.log(
    process.env.HA_WEBHOOK_URL
      ? "   ✔ Skickad! Kolla din mobil."
      : "   ⏭ HA_WEBHOOK_URL saknas – notisen skrevs bara ut ovan."
  );
  console.log("\n=== TEST KLART ===");
}
