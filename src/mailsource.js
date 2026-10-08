// Läser bevakningsmejl från Hemnet och Booli i en egen inkorg (IMAP) och
// omvandlar dem till annonser. Booli mejlar via en spårningstjänst
// (booli.ungapped.io) som dubbel-kodar den riktiga länken – därför avkodas
// texten flera varv, och adress/bild plockas ur mejlets HTML.
// Kräver IMAP_USER + IMAP_PASSWORD (och IMAP_HOST om inte Gmail).
import { geokoda } from "./geocode.js";
import { myndighetForOrt } from "./lan.js";

export function harImap() {
  return Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

// importAvsandare: adresser vars mejl tolkas som en inklistrad Hemnet-söksida
// (se tolkaInklistradSida). Inkorgens egen adress räknas alltid dit.
export async function hamtaMailAnnonser(areas = [], { importAvsandare = [] } = {}) {
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const { tolkaSlutpriserMail } = await import("./slutpriser.js");

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: 993,
    secure: true,
    logger: false,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  });

  const annonser = new Map();
  const slutpriser = [];
  const tillatnaImport = new Set(
    [...importAvsandare, process.env.IMAP_USER].filter(Boolean).map((s) => String(s).trim().toLowerCase())
  );
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    console.log(`  ${uids.length} olästa mejl i inkorgen.`);
    for (const uid of uids) {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      const mail = await simpleParser(content);
      const avsandare = (mail.from?.text ?? "").toLowerCase();
      const avsandarAdress = (mail.from?.value?.[0]?.address ?? "").toLowerCase();
      if (tillatnaImport.has(avsandarAdress)) {
        const lista = tolkaInklistradSida(mail.html || "", mail.text || "");
        console.log(`  Import från ${avsandarAdress}: ${lista.length} annonser i "${mail.subject ?? ""}".`);
        for (const a of lista) annonser.set(a.id, { ...a, import: true });
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        continue;
      }
      if (!/hemnet|booli/.test(avsandare)) continue;

      // Slutpriser-bevakning: sålda hus används bara för prisstatistik,
      // skapar aldrig egna annonser/notiser.
      if (/slutpris/i.test(mail.subject ?? "")) {
        slutpriser.push(...tolkaSlutpriserMail(mail.html || ""));
      } else {
        // Hemnets dagliga sammanfattningsmejl ("Nytt i dina bevakningar")
        // innehåller efter de riktiga sökträffarna även en "Upptäck fler
        // bostäder"-sektion med Hemnets EGNA rekommendationer ("Hemnet Max")
        // – inte träffar på den sparade sökningen. Delas i två delar så de
        // kan hållas isär och taggas separat, istället för att blandas in
        // som om de vore riktiga bevakningsträffar.
        const { fore: html, efter: rekHtml } = delaVidRekommendationer(mail.html || "");
        const { fore: text, efter: rekText } = delaVidRekommendationer(mail.text || "");

        for (const a of berikaMedDigest(html, text)) annonser.set(a.id, a);
        if (rekText) {
          for (const a of berikaMedDigest(rekHtml, rekText)) {
            annonser.set(a.id, { ...a, kalla: "Hemnet Max" });
          }
        }
      }
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  // Slå upp koordinater. geokoda() sköter både sin egen taktning mot
  // Nominatim (max 1 anrop/sek) och ordningen mellan ortskandidater, och
  // returnerar bara träffar där kommunen är verifierad – se geocode.js.
  //
  // Den gamla byggFragor() är borta med flit. Den skickade Hemnet-annonser
  // helt utan ort att verifiera mot, och gav Booli-annonser en sista fråga
  // utan ort som "sista chansen". Båda gjorde att första bästa träff i hela
  // Sverige accepterades blint, vilket placerade Roslagen-hus i Uppsala och
  // ett hus ända nere vid Trosa.
  for (const a of annonser.values()) {
    if (a.lat != null) continue;
    if (!a.adress) continue;
    // Snävast ledtråd först: annonsens kommun, sedan dess ort, sist de breda
    // bevakningsområdena ur config.json.
    const pos = await geokoda(a.gatuadress || a.adress, {
      ort: a.ort,
      // Annonsens egen kommun låser uppslaget till rätt kommun – de breda
      // bevakningsområdena används bara när annonsen inte säger något.
      kommunText: a.kommunText,
      omraden: areas,
    });
    if (pos) {
      a.lat = pos.lat;
      a.lon = pos.lon;
      a.kommun = pos.kommunNamn;
      a.lan = pos.lan;
      a.myndighet = pos.myndighet;
      a.platsPrecision = pos.precision;
      a.platsKalla = pos.kalla;
      if (!a.ort) a.ort = pos.kommunNamn;
    }
  }
  return { annonser: [...annonser.values()], slutpriser };
}

// Hittar Hemnet-/Booli-annonser i mejlets HTML. Parar ihop annons-id (ur
// länken, ev. dubbel-kodad i en spårningslänk) med adress, bild och de
// synliga fälten (typ, område, pris, boarea, rum, tomt).
export function hittaAnnonser(html, plaintext = "") {
  const text = html;
  const resultat = new Map();
  const detaljer = laddaDetaljer(html);

  const nyBooli = (booliId) => ({
    id: `booli-${booliId}`,
    kalla: "Booli",
    url: `https://www.booli.se/annons/${booliId}`,
    typ: "",
    rum: null,
    adress: null,
    ort: "",
    gatuadress: null,
    kommunText: "",
    bild: null,
    pris: null,
    boarea: null,
    tomtarea: null,
    lat: null,
    lon: null,
  });

  // 1) Gå igenom alla <a>-taggar och para id ↔ adresstext ↔ bild
  for (const m of text.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = flerAvkoda(m[1]) + "\n" + (avslojaHemnetSparlank(m[1]) ?? "");
    const inner = m[2];
    const img = inner.match(/<img\b[^>]*src="(https?:\/\/[^"]+?)"/i)?.[1];
    const rentText = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const booliId = href.match(/booli\.se\/annons\/(\d+)/)?.[1];
    const hemnetSlug = href.match(/hemnet\.se\/bostad\/([a-z0-9-]+)/i)?.[1];

    if (booliId) {
      const id = `booli-${booliId}`;
      const e = resultat.get(id) ?? nyBooli(booliId);
      if (img && arHusbild(img) && !e.bild) e.bild = httpsBild(img);
      if (!e.adress && rimligAdress(rentText)) e.adress = rentText;
      resultat.set(id, e);
    } else if (hemnetSlug) {
      const bas = tolkaHemnetSlug(hemnetSlug);
      if (!bas) continue;
      const e = resultat.get(bas.id) ?? bas;
      if (img && arHusbild(img) && !e.bild) e.bild = httpsBild(img);
      resultat.set(bas.id, e);
    }
  }

  // 2) Fallback: fånga länkar som inte satt i en <a> (dekoda hela texten)
  const avkodad = flerAvkoda(html + "\n" + plaintext);
  for (const m of avkodad.matchAll(/booli\.se\/annons\/(\d+)/g)) {
    if (!resultat.has(`booli-${m[1]}`)) resultat.set(`booli-${m[1]}`, nyBooli(m[1]));
  }
  for (const m of avkodad.matchAll(/hemnet\.se\/bostad\/([a-z0-9-]+)/gi)) {
    const bas = tolkaHemnetSlug(m[1]);
    if (bas && !resultat.has(bas.id)) resultat.set(bas.id, bas);
  }

  // 3) Fyll på med synliga fält (pris, yta m.m.) matchat på adress
  for (const e of resultat.values()) {
    const d = detaljer.get(normAdr(e.adress)) || detaljer.get(normAdr((e.adress || "").split(",")[0]));
    if (!d) continue;
    if (!e.typ) e.typ = d.typ;
    if (!e.ort) e.ort = d.ort;
    if (e.pris == null) e.pris = d.pris;
    if (e.boarea == null) e.boarea = d.boarea;
    if (e.rum == null) e.rum = d.rum;
    if (e.tomtarea == null) e.tomtarea = d.tomtarea;
  }
  return [...resultat.values()];
}

const normAdr = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Läser de synliga husblocken ur mejlets HTML. Varje block ser ut som:
//   Idegransvägen 35 / Villa · Skölsta / 4 800 000 kr / 125 m²   6 rum
export function laddaDetaljer(html) {
  const rader = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&sup2;/gi, "²").replace(/&middot;|&#183;/gi, "·")
    .split("\n").map((s) => s.trim()).filter(Boolean);

  const detaljer = new Map();
  const typRad = /^(villa|fritidshus|radhus|parhus|kedjehus|gård|gård|tomt|lägenhet)\s*[·•]\s*(.+)$/i;
  for (let i = 1; i < rader.length; i++) {
    const m = rader[i].match(typRad);
    if (!m) continue;
    const adress = rader[i - 1];
    if (!adress || adress.length > 60) continue;

    let pris = null, boarea = null, rum = null, tomtarea = null;
    for (let j = i + 1; j < Math.min(i + 4, rader.length); j++) {
      const r = rader[j];
      const p = r.match(/([\d][\d\s]*)\s*kr/);
      if (p && pris === null) pris = Number(p[1].replace(/\s/g, ""));
      const areor = [...r.matchAll(/(\d[\d\s]*)\s*(?:m²|m2|kvm)/gi)].map((x) => Number(x[1].replace(/\s/g, "")));
      const rm = r.match(/(\d+(?:[.,]\d)?)\s*rum/i);
      if (rm && rum === null) rum = Number(rm[1].replace(",", "."));
      if (areor.length && boarea === null) {
        boarea = areor[0];
        if (areor.length > 1) tomtarea = areor[areor.length - 1];
      }
    }
    detaljer.set(normAdr(adress), { typ: m[1].toLowerCase(), ort: m[2].trim(), pris, boarea, rum, tomtarea });
  }
  return detaljer;
}

// Hemnets söksida inklistrad i ett mejl (Ctrl+A, Ctrl+C på hemnet.se, klistra
// in i ett nytt mejl till bevakningsadressen). Bevakningsmejlen innehåller
// bara NYA annonser – det här är vägen in för det som redan låg ute när
// bevakningen startade. Varje sökträff är ett enda <a> runt hela kortet:
//   Stallgränd 4 / Degerhamn, Mörbylånga kommun / 1 875 000 kr /
//   121 + 56 m² / 5 rum / 1 056 m² tomt
// Betalda placeringar ("Betald placering", "Mäklartipset") ligger i samma
// lista men följer inte sökningen – de är lägenheter i Bromma och fjällstugor
// i Hemavan – så de hoppas över, liksom allt utanför de bevakade länen.
export function tolkaInklistradSida(html, text = "") {
  const kort = new Map();
  const lankRe = /<a\b[^>]*?href=["'][^"']*?\/bostad\/([a-z0-9-]+-\d{6,})[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const [, slug, inre] of (html || "").matchAll(lankRe)) {
    const id = slug.match(/-(\d{6,})$/)[1];
    const e = kort.get(id) ?? { slug, rader: [], bild: null, betald: false };
    const rader = tillRader(inre);
    if (rader.some((r) => /^(betald placering|mäklartipset)$/i.test(r))) e.betald = true;
    e.rader.push(...rader);
    const img = inre.match(/<img\b[^>]*?\ssrc=["'](https?:\/\/[^"']+)["']/i)?.[1];
    if (img && arHusbild(img) && !e.bild) e.bild = httpsBild(img.replace(/&amp;/g, "&"));
    kort.set(id, e);
  }
  // Klienter som bara skickar ren text: länkarna står då som
  // "... ( https://www.hemnet.se/bostad/... )". Bara sluggen att gå på.
  if (!kort.size) {
    for (const [, slug] of (text || "").matchAll(/hemnet\.se\/bostad\/([a-z0-9-]+-\d{6,})/gi)) {
      const id = slug.match(/-(\d{6,})$/)[1];
      if (!kort.has(id)) kort.set(id, { slug, rader: [], bild: null, betald: false });
    }
  }

  const resultat = [];
  for (const e of kort.values()) {
    if (e.betald) continue;
    const a = tolkaHemnetSlug(e.slug);
    if (!a) continue;
    const d = tolkaKortrader(e.rader);
    // Kortet stavar med å/ä/ö ("Vinäs"), sluggen inte ("vinas") – kortets
    // version ger bättre geokodning när den finns.
    if (d.gata) { a.adress = d.gata; a.gatuadress = d.gata; }
    if (d.ort) a.ort = d.ort;
    if (d.kommunText) a.kommunText = d.kommunText;
    a.pris = d.pris; a.boarea = d.boarea; a.rum = d.rum ?? a.rum; a.tomtarea = d.tomtarea;
    a.bild = e.bild;
    if (!myndighetForOrt(a.kommunText || a.ort)) continue;
    resultat.push(a);
  }
  return resultat;
}

// Ett Hemnet-korts synliga rader → fälten. Raderna kommer i fast form men
// med valfria inslag (visningstid, "Premium", "Balkong") runt omkring, så
// varje fält känns igen på sitt eget mönster istället för sin position.
export function tolkaKortrader(raRader) {
  const d = { gata: null, ort: null, kommunText: null, pris: null, boarea: null, rum: null, tomtarea: null };
  const tal = (s) => Number(s.replace(/\s/g, "").replace(",", "."));
  // Boarea + biarea ligger i separata element ("121" | "+" | "56 m²") och
  // blir separata rader – sätt ihop dem, annars läses biarean som boarea.
  const rader = [];
  for (let i = 0; i < raRader.length; i++) {
    if (/^\d[\d\s]*(?:,\d+)?$/.test(raRader[i]) && raRader[i + 1] === "+" && /m²$/.test(raRader[i + 2] ?? "")) {
      rader.push(`${raRader[i]} + ${raRader[i + 2]}`);
      i += 2;
    } else rader.push(raRader[i]);
  }
  // Mellan adressen och orten ligger en visuellt dold hustypsrad ("Villa").
  const typRad = /^(villa|radhus|parhus|kedjehus|fritidsboende|fritidshus|gård|gårdar|tomt|lägenhet|bostadsrätt|övrigt)$/i;
  for (let i = 0; i < rader.length; i++) {
    const r = rader[i];
    const ortM = r.match(/^(.+),\s*(.+?)\s+kommun$/i);
    if (ortM && !d.ort) {
      d.ort = ortM[1].trim();
      d.kommunText = ortM[2].trim();
      let j = i - 1;
      while (j >= 0 && typRad.test(rader[j])) j--;
      if (j >= 0 && rader[j].length <= 60) d.gata = rader[j];
      continue;
    }
    let m;
    if (d.pris == null && (m = r.match(/^(\d[\d\s]*)\s*kr$/i))) d.pris = tal(m[1]);
    else if (d.tomtarea == null && (m = r.match(/^(\d[\d\s]*)\s*m²\s*tomt$/i))) d.tomtarea = tal(m[1]);
    else if (d.boarea == null && (m = r.match(/^(\d[\d\s]*(?:,\d+)?)(?:\s*\+\s*\d[\d\s]*)?\s*m²$/i))) d.boarea = tal(m[1]);
    else if (d.rum == null && (m = r.match(/^(\d+(?:[,.]\d)?)\s*rum$/i))) d.rum = tal(m[1]);
  }
  return d;
}

function tillRader(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&sup2;|&#178;|&#xb2;/gi, "²")
    .replace(/&amp;/gi, "&").replace(/&#8211;|&ndash;/gi, "–")
    .replace(/[​-‍﻿]/g, "").replace(/ /g, " ")
    .split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// Hemnets adress-slug bär på mycket: "villa-6rum-rimbo-norrtalje-kommun-vallbyvagen-10-21398433"
// Ordet "kommun" skiljer område (före) från gatuadress (efter).
export function tolkaHemnetSlug(slug) {
  const id = slug.match(/-(\d{6,})$/)?.[1];
  if (!id) return null;
  const delar = slug.replace(/-\d{6,}$/, "").split("-");
  const typ = delar.shift() ?? "";
  const rum = delar.find((d) => /^\d+rum$/.test(d));
  const adressOrd = delar.filter((d) => /^\d+rum$/.test(d) === false && d !== "rum");

  const ix = adressOrd.lastIndexOf("kommun");
  const plats = ix >= 0 ? adressOrd.slice(0, ix) : [];
  const gata = ix >= 0 ? adressOrd.slice(ix + 1) : adressOrd;
  const kommunNamn = plats.at(-1) ?? "";

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  // Vissa Hemnet-länkar (t.ex. digestmejl) saknar helt adressord i sluggen –
  // då blir både gata och plats tomma. Utan fallback här försvinner huset
  // spårlöst: det markeras ändå som "sett" men får ingen visningsbar adress.
  const adress = [cap(gata.join(" ")), plats.map(cap).join(" ")].filter(Boolean).join(", ")
    || `${cap(typ) || "Bostad"} (adress saknas, hemnet-${id})`;

  return {
    id: `hemnet-${id}`,
    kalla: "Hemnet",
    url: `https://www.hemnet.se/bostad/${slug}`,
    typ,
    rum: rum ? Number(rum.replace("rum", "")) : null,
    adress,
    ort: plats.map(cap).join(" "),
    // Ren gatuadress utan ortsdelen – det är den som ska in i Nominatims
    // `street`-fält. Skickas hela "Simpnäsvägen 13, Väddö Norrtälje" dit
    // blir den strukturerade sökningen sämre, inte bättre.
    gatuadress: cap(gata.join(" ")) || null,
    // Sluggen stavar ut kommunen ("...-vaddo-norrtalje-kommun-...") – den
    // starkaste ledtråden som fanns i datan hela tiden men aldrig användes.
    kommunText: cap(kommunNamn),
    bild: null,
    pris: null, boarea: null, tomtarea: null, lat: null, lon: null,
  };
}

// Hemnets sammanfattningsmejl länkar via en click-tracking-wrapper
// (ciomail.hemnet.se/e/c/<base64>/<hash>) vars riktiga mål ligger
// base64-kodat som JSON i path:en – inte procent-kodat, så flerAvkoda
// hittar det inte. Utan avkodning tappas både id och (eftersom bilden
// ligger i SAMMA <a>-tagg) bilden för de här mejlen.
function avslojaHemnetSparlank(href) {
  const m = href.match(/ciomail\.hemnet\.se\/e\/c\/([A-Za-z0-9+/=_-]+?)\//);
  if (!m) return null;
  try {
    const json = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    return typeof json.href === "string" ? json.href : null;
  } catch {
    return null;
  }
}

// Delar Hemnets sammanfattningsmejl vid "Upptäck fler bostäder" – allt
// före är riktiga sökträffar, allt efter är Hemnets EGNA rekommendationer
// ("Hemnet Max"). Finns ingen sådan sektion hamnar allt i "fore".
export function delaVidRekommendationer(s) {
  const ix = s.search(/Upptäck fler bostäder/i);
  return ix >= 0 ? { fore: s.slice(0, ix), efter: s.slice(ix) } : { fore: s, efter: "" };
}

// Kör den vanliga annons-extraktionen och berikar med adress/ort/yta/rum/
// pris från digest-parsern (om mejlet var av den typen) – delad logik för
// både huvudsektionen och (om separerad) rekommendationssektionen.
function berikaMedDigest(html, text) {
  const digest = new Map(tolkaHemnetDigest(text).map((a) => [a.id, a]));
  return hittaAnnonser(html, text).map((a) => {
    const d = digest.get(a.id);
    return d ? { ...a, ...d, bild: a.bild ?? d.bild } : a;
  });
}

// Tolkar husblocken i Hemnets sammanfattningsmejl ur textversionen (renare
// än HTML:en – klarar sig utan taggstripping). Varje block ser ut som:
//   Fasternavägen
//   Rimbo, Norrtälje kommun
//   128 m²
//   ·
//   5 rum
//   ·
//   3 495 000 kr
//   [ev. märke: Underhand/Budgivning pågår/datum]
//   Visa bostaden ( https://www.hemnet.se/bostad/-21758739?... )
// Ankrar på "NNN m²"-raden (mest entydig) och läser adress/ort två rader
// bakåt, rum/pris/länk några rader framåt.
export function tolkaHemnetDigest(text) {
  // Hemnets mejl innehåller osynliga nollbreddstecken (radbrytningshintar)
  // och hårda mellanslag (t.ex. "Norrmarken 7" mellan gatunamn och
  // nummer) – normaliseras bort, annars kan de smyga med i adressen och
  // tysta förstöra geokodningen senare.
  const rader = text
    .split("\n")
    .map((s) => s.replace(/[​-‍﻿]/g, "").replace(/ /g, " ").trim())
    .filter(Boolean);
  const resultat = [];

  for (let i = 2; i < rader.length; i++) {
    const areaM = rader[i].match(/^(\d[\d\s]*)\s*m²$/);
    if (!areaM) continue;
    const ort = rader[i - 1];
    const adress = rader[i - 2];
    if (!ort || !adress || !ort.includes(",") || adress.length > 60) continue;

    let rum = null, pris = null, id = null;
    for (let j = i + 1; j < Math.min(i + 10, rader.length); j++) {
      const rm = rader[j].match(/^(\d+)\s*rum$/i);
      if (rm && rum === null) rum = Number(rm[1]);
      const p = rader[j].match(/^([\d][\d\s]*)\s*kr$/);
      if (p && pris === null) pris = Number(p[1].replace(/\s/g, ""));
      const l = rader[j].match(/hemnet\.se\/bostad\/(-?\d+)/i);
      if (l && id === null) id = `hemnet-${l[1].replace(/^-/, "")}`;
      if (id !== null && (rum !== null || pris !== null)) break;
    }
    if (!id) continue;

    resultat.push({
      id,
      kalla: "Hemnet",
      url: `https://www.hemnet.se/bostad/${id.replace("hemnet-", "-")}`,
      typ: "",
      rum,
      adress,
      ort: ort.split(",")[0].trim(),
      // Ortsraden ser ut som "Väddö, Norrtälje kommun". Kommunen efter kommat
      // är den starkaste ledtråden vi har om var huset FAKTISKT ligger – den
      // kastades tidigare bort, och utan den chansade geokodningen på
      // bevakningsområdena ("Uppsala" först) med Roslagen-hus i Uppsala som
      // följd. Nu binder den träffen till rätt kommun.
      kommunText: ort.split(",").slice(1).join(",").trim(),
      gatuadress: adress,
      bild: null,
      pris,
      boarea: Number(areaM[1].replace(/\s/g, "")),
      tomtarea: null,
      lat: null,
      lon: null,
    });
  }
  return resultat;
}

// Avkodar procent-kodning upp till tre varv (spårningslänkar dubbel-kodar).
function flerAvkoda(s) {
  let ut = s;
  for (let i = 0; i < 3; i++) {
    let d;
    try { d = decodeURIComponent(ut.replace(/%(?![0-9A-Fa-f]{2})/g, "%25")); } catch { break; }
    if (d === ut) break;
    ut = d;
  }
  return s + "\n" + ut;
}

// Ser texten ut som en gatuadress (och inte en knapp/rubrik)?
function rimligAdress(t) {
  if (!t || t.length > 60 || !/[a-zåäö]/i.test(t)) return false;
  if (/(visa|annons|bostad|klicka|avreg|inställ|prenumer|logga|se mer|utforska|här\b)/i.test(t)) return false;
  return /\d/.test(t) || /(väg|vägen|gata|gatan|stig|stigen|gränd|backe|backen|torg|plan|allé|liden|höjden|gårde)/i.test(t);
}

function arHusbild(url) {
  return !/logo|icon|spacer|pixel|tracking|footer|header/i.test(url);
}
function httpsBild(url) {
  return url.replace(/^http:/i, "https:");
}
