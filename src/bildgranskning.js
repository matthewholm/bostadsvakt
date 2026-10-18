// Tittar på annonsens alla foton tillsammans med pris och uppgifter, och
// säger vad de visar om husets skick: fuktfläckar, sprickor, rötskador,
// gamla våtrum, och det som ser bra ut. Resultatet sparas per hus i
// husuppgifter.json (fältet `bildgranskning`) och ritas som ett eget avsnitt i
// Alva, se sida.js.
//
// Modellen är Claude Opus 5.5. Det här är ett omdöme som ska kunna bära ett
// beslut om ett bud, inte en sammanfattning. Uträknat på listpriset, inte
// mätt: ett foto blir högst runt 1 600 tokens, alltså under en tiondels krona,
// och en annons med fyrtio bilder hamnar kring tre till fem kronor med svaret
// inräknat. Granskningen görs en gång per inskickad annons, aldrig per körning.
//
// Det här är inte en besiktning och får aldrig låta som en. Ett foto visar
// en yta, inte vad som finns bakom den, och annonsfoton är valda, ljussatta
// och ofta redigerade. Att inget syns är därför inget bevis för att inget
// finns, och prompten säger det rakt ut.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const MODELL = "claude-opus-5-5";

// API:ts gränser: 5 MB per bild, 32 MB per anrop, och när fler än 20 bilder
// skickas får ingen sida vara längre än 2 000 px. Taket på totalen ligger
// under 32 MB med marginal för base64 (fyra tecken per tre byte).
const MAX_BILDER = 40;
const MAX_PER_BILD = 5 * 1024 * 1024;
const MAX_TOTALT = 20 * 1024 * 1024;
const MAX_SIDA_MANGA = 2000;
const HAMTA_TIMEOUT_MS = 15_000;

/** Bildformat och storlek ur filens egna första byte, inte ur adressen. */
export function bildInfo(buf) {
  const b = buf;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { typ: "image/png", bredd: b.readUInt32BE(16), hojd: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const markor = b[i + 1];
      const langd = b.readUInt16BE(i + 2);
      // SOF0–SOF15 bär bildens mått, utom DHT (C4), JPG (C8) och DAC (CC).
      if (markor >= 0xc0 && markor <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(markor)) {
        return { typ: "image/jpeg", hojd: b.readUInt16BE(i + 5), bredd: b.readUInt16BE(i + 7) };
      }
      i += 2 + langd;
    }
    return { typ: "image/jpeg", bredd: null, hojd: null };
  }
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const del = b.toString("ascii", 12, 16);
    if (del === "VP8X") return { typ: "image/webp", bredd: 1 + b.readUIntLE(24, 3), hojd: 1 + b.readUIntLE(27, 3) };
    if (del === "VP8 ") return { typ: "image/webp", bredd: b.readUInt16LE(26) & 0x3fff, hojd: b.readUInt16LE(28) & 0x3fff };
    if (del === "VP8L") {
      const v = b.readUInt32LE(21);
      return { typ: "image/webp", bredd: (v & 0x3fff) + 1, hojd: ((v >> 14) & 0x3fff) + 1 };
    }
    return { typ: "image/webp", bredd: null, hojd: null };
  }
  return null;
}

/**
 * Väljer vilka av de hämtade bilderna som får följa med, efter API:ts
 * gränser. Ordningen behålls, för den är annonsens egen och bildnumren i
 * svaret pekar på den.
 */
export function valjBilder(bilder) {
  const sida = (b) => Math.max(b.info.bredd ?? 0, b.info.hojd ?? 0);
  const ok = bilder.filter((b) => b.info && b.data.length <= MAX_PER_BILD && sida(b) <= 8000);
  const fyll = (lista, max) => {
    const valda = [];
    let summa = 0;
    for (const b of lista) {
      if (valda.length >= max || summa + b.data.length > MAX_TOTALT) break;
      valda.push(b);
      summa += b.data.length;
    }
    return valda;
  };
  // Två sätt att hålla sig inom gränserna: många bilder som alla är högst
  // 2 000 px, eller högst 20 av vilken storlek som helst. Det som ger flest
  // bilder vinner, så att en annons med stora foton inte tappar allt.
  const manga = fyll(ok.filter((b) => sida(b) <= MAX_SIDA_MANGA), MAX_BILDER);
  const stora = fyll(ok, 20);
  return manga.length >= stora.length ? manga : stora;
}

/** Hämtar bilderna, fyra åt gången. Kastar aldrig: en bild som inte gick
 *  att hämta hoppas över och räknas. */
export async function hamtaBilder(urls, { referer } = {}) {
  const ut = new Array(urls.length);
  let nasta = 0;
  const arbetare = async () => {
    while (nasta < urls.length) {
      const i = nasta++;
      try {
        const res = await fetch(urls[i], {
          headers: {
            "User-Agent": "Bostadsvakt-bot/1.0 (+github.com/matthewholm/bostadsvakt)",
            Accept: "image/avif,image/webp,image/jpeg,image/png,*/*;q=0.5",
            ...(referer ? { Referer: referer } : {}),
          },
          signal: AbortSignal.timeout(HAMTA_TIMEOUT_MS),
        });
        if (!res.ok) { ut[i] = { url: urls[i], fel: `HTTP ${res.status}` }; continue; }
        const data = Buffer.from(await res.arrayBuffer());
        const info = bildInfo(data);
        ut[i] = info ? { url: urls[i], data, info } : { url: urls[i], fel: "inte en bild" };
      } catch (err) {
        ut[i] = { url: urls[i], fel: err.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, arbetare));
  return ut;
}

const Fynd = z.object({
  bild: z.number().int().nullable().describe("Bildens nummer (1, 2, ...) där det syns, eller null om det kommer från texten."),
  var: z.string().describe("Var i huset, t.ex. Källare, Badrum, Fasad, Tak, Kök."),
  ton: z.enum(["bra", "notera", "varning"]),
  vad: z.string().describe("Vad som syns, kort, högst 110 tecken."),
  kolla: z.string().nullable().describe("Vad som bör kontrolleras på visningen eller frågas, högst 110 tecken, eller null."),
});

export const Granskning = z.object({
  helhet: z.enum(["bra", "blandat", "varning", "går inte att bedöma"]),
  sammanfattning: z.string().describe("Två till tre meningar: helhetsintrycket av skicket och det viktigaste fyndet."),
  fynd: z.array(Fynd),
  pris: z.string().nullable().describe("En mening om hur skicket förhåller sig till priset, bara om prisuppgifter finns, annars null."),
  syns_inte: z.array(z.string()).describe("Delar av huset som inte syns på någon bild men borde ha gjort det, t.ex. källare, tak, badrum."),
});

const SYSTEM = [
  "Du granskar fotona i en svensk bostadsannons åt ett hushåll som funderar på att lägga bud.",
  "Du får alla annonsens bilder numrerade i ordning, plus pris och de uppgifter som gick att läsa ur annonsen.",
  "",
  "Leta efter tecken på skador och eftersatt underhåll, och säg också vad som ser bra ut:",
  "- fukt och mögel: fläckar, missfärgning, saltutfällningar eller avflagnande färg på källarväggar och golv, fuktränder vid golvlist, plastmatta eller heltäckningsmatta på källargolv, bubblig tapet",
  "- våtrum: ålder på kakel och klinker, fogar, golvbrunn, silikon, plastmatta som släppt, tecken på läckage under diskbänk",
  "- tak och fasad: mossa, trasiga eller sneda pannor, rost på plåt, sprickor i puts, rötskador vid syll och fönster, färg som släpper, hängrännor",
  "- grund och mark: sprickor i grundmur, marken som lutar mot huset, vatten nära grunden, krypgrund eller torpargrund",
  "- el, värme och ventilation: gammal elcentral, äldre radiatorer eller panna, synliga installationer",
  "- tydligt nyrenoverat, nytt tak, nya fönster och liknande är fynd med tonen bra",
  "",
  "Regler:",
  "- Skriv bara det du faktiskt ser, och ange bildens nummer. Det som bara står i texten får bild null.",
  "- Skilj på vad som syns och vad det kan tyda på. Skriv 'kan tyda på fukt', aldrig 'det är fuktskadat', om du inte ser själva skadan.",
  "- Annonsfoton är valda och ofta redigerade. Att inget syns är inget bevis för att inget finns. Nämn i syns_inte det som saknas bland bilderna, till exempel om källaren, vinden eller badrummet inte visas alls.",
  "- Hitta aldrig på uppgifter, mått, årtal eller kostnader. Nämn priset bara om prisuppgifter finns i meddelandet, och räkna inte fram egna belopp.",
  "- helhet: 'bra' när inget av vikt syns, 'blandat' när det finns saker att kolla men inget som ser allvarligt ut, 'varning' när något kan tyda på fukt, röta, sättningar eller annat som kan bli dyrt. 'går inte att bedöma' när bilderna inte visar husets skick alls.",
  "- Skriv på svenska, kort och sakligt. Ingen hälsning, inga rubriker. Det här är inte en besiktning och ska inte låta som en.",
].join("\n");

export function harNyckel() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Granskar bilderna. `fakta` är de rader som redan är kända om huset (pris,
 * byggår, boarea, prisjämförelse), `beskrivning` annonsens egen text, som
 * ofta säger det bilderna inte visar ("stambyte 2015", "fuktmätning gjord").
 * Ger null utan nyckel, utan bilder eller om anropet går fel; det avgör
 * aldrig något annat i flödet.
 */
export async function granskaBilder({ bilder, adress, fakta = [], beskrivning = "" }, { klient } = {}) {
  if (!bilder?.length) return null;
  if (!klient && !harNyckel()) return null;
  const anthropic = klient ?? new Anthropic();

  const innehall = [];
  bilder.forEach((b, i) => {
    innehall.push({ type: "text", text: `Bild ${i + 1}:` });
    innehall.push({ type: "image", source: { type: "base64", media_type: b.info.typ, data: b.data.toString("base64") } });
  });
  innehall.push({
    type: "text",
    text: [
      `Bostad: ${adress || "okänd adress"}.`,
      fakta.length ? `Kända uppgifter:\n${fakta.map((f) => `- ${f}`).join("\n")}` : "Inga uppgifter utöver bilderna.",
      beskrivning ? `Annonsens text (förkortad):\n${beskrivning.slice(0, 6000)}` : "",
    ].filter(Boolean).join("\n\n"),
  });

  try {
    const svar = await anthropic.beta.messages.parse({
      model: MODELL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "high", format: betaZodOutputFormat(Granskning) },
      messages: [{ role: "user", content: innehall }],
    });
    if (svar.stop_reason === "refusal") {
      console.warn(`  Bildgranskningen avböjdes (${svar.stop_details?.category ?? "okänd kategori"}).`);
      return null;
    }
    if (!svar.parsed_output) {
      console.warn(`  Bildgranskningen gav inget läsbart svar (stop_reason ${svar.stop_reason}).`);
      return null;
    }
    return {
      ...svar.parsed_output,
      antalBilder: bilder.length,
      bilder: bilder.map((b) => b.url),
      modell: svar.model,
      granskad: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.warn(`  Claude svarade ${err.status} på bildgranskningen: ${err.message.slice(0, 200)}`);
    else console.warn(`  Bildgranskningen nådde inte fram: ${err.message}`);
    return null;
  }
}

const HELHET = {
  bra: "✓ Bilderna ser bra ut",
  blandat: "Bilderna: några saker att kolla",
  varning: "⚠ Bilderna visar varningstecken",
  "går inte att bedöma": "Bilderna visar inte husets skick",
};

const kort = (s, max = 118) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);

/**
 * Raderna i avsnittet BILDGRANSKNING. Varje fynd blir en rad som börjar med
 * sin plats, så att den läses som "Källare: ..." i Alva, och varningar får ⚠
 * först, vilket är det Alva ritar som en varningsruta. Sammanfattningen är
 * lång med flit: den är ett omdöme och ritas som löptext.
 */
export function bildgranskningRader(g) {
  if (!g) return [];
  // Förbehållet står direkt under omdömet och inte sist: en yta som fäller
  // ihop långa avsnitt ska aldrig visa omdömet utan att visa vad det är.
  const rader = [
    HELHET[g.helhet] ?? g.helhet,
    g.sammanfattning,
    `${g.antalBilder} bilder granskade ${g.granskad?.slice(0, 10) ?? ""}. Inte en besiktning.`.replace(" .", "."),
  ];
  const ordning = { varning: 0, notera: 1, bra: 2 };
  const fynd = [...(g.fynd ?? [])].sort((a, b) => ordning[a.ton] - ordning[b.ton]);
  for (const f of fynd) {
    const bild = f.bild ? ` (bild ${f.bild})` : "";
    const forst = f.ton === "varning" ? "⚠ " : f.ton === "bra" ? "✓ " : "";
    rader.push(kort(`${forst}${f.var}: ${f.vad}${bild}`));
    if (f.kolla && f.ton !== "bra") rader.push(kort(`Kolla: ${f.kolla}`));
  }
  if (g.pris) rader.push(g.pris);
  if (g.syns_inte?.length) rader.push(kort(`Syns inte på bilderna: ${g.syns_inte.join(", ")}`));
  return rader;
}

/** Kort text för notisen: helheten, sammanfattningen och varningarna. */
export function bildgranskningNotis(g) {
  if (!g) return [];
  const varningar = (g.fynd ?? []).filter((f) => f.ton === "varning").map((f) => `⚠ ${f.var}: ${f.vad}`);
  return [HELHET[g.helhet] ?? g.helhet, g.sammanfattning, ...varningar.slice(0, 4)];
}

/**
 * Hela vägen från en sidas bildadresser till ett omdöme: hämta, välj, granska.
 * Loggar vad som föll bort, så att "12 av 40 bilder" inte ser ut som en
 * annons med tolv bilder.
 */
export async function granskaAnnonsbilder({ urls, referer, adress, fakta, beskrivning }) {
  if (!urls?.length) return null;
  if (!harNyckel()) {
    console.log("  Bildgranskning hoppas över: ANTHROPIC_API_KEY saknas.");
    return null;
  }
  const hamtade = await hamtaBilder(urls.slice(0, 80), { referer });
  const fel = hamtade.filter((b) => b.fel);
  const valda = valjBilder(hamtade.filter((b) => !b.fel));
  console.log(`  Bilder: ${urls.length} hittade, ${hamtade.length - fel.length} hämtade, ${valda.length} granskas.`);
  if (fel.length) console.log(`  Kunde inte hämta ${fel.length}: ${fel.slice(0, 3).map((b) => `${b.fel} (${b.url})`).join("; ")}`);
  return granskaBilder({ bilder: valda, adress, fakta, beskrivning });
}
