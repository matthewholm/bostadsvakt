// Läser bevakningsmejl från Hemnet och Booli i en egen inkorg (IMAP) och
// omvandlar dem till annonser. Booli mejlar via en spårningstjänst
// (booli.ungapped.io) som dubbel-kodar den riktiga länken – därför avkodas
// texten flera varv, och adress/bild plockas ur mejlets HTML.
// Kräver IMAP_USER + IMAP_PASSWORD (och IMAP_HOST om inte Gmail).
import { geokoda } from "./geocode.js";

const paus = (ms) => new Promise((r) => setTimeout(r, ms));

export function harImap() {
  return Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

export async function hamtaMailAnnonser(areas = []) {
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
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    console.log(`  ${uids.length} olästa mejl i inkorgen.`);
    for (const uid of uids) {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      const mail = await simpleParser(content);
      const avsandare = (mail.from?.text ?? "").toLowerCase();
      if (!/hemnet|booli/.test(avsandare)) continue;

      // Slutpriser-bevakning: sålda hus används bara för prisstatistik,
      // skapar aldrig egna annonser/notiser.
      if (/slutpris/i.test(mail.subject ?? "")) {
        slutpriser.push(...tolkaSlutpriserMail(mail.html || ""));
      } else {
        for (const a of hittaAnnonser(mail.html || "", mail.text || "")) annonser.set(a.id, a);
      }
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  // Slå upp koordinater (varsamt: Nominatim vill ha max 1 anrop/sek)
  for (const a of annonser.values()) {
    if (a.lat != null) continue;
    for (const { fraga, ort } of byggFragor(a, areas)) {
      const pos = await geokoda(fraga);
      await paus(1100);
      if (pos) {
        a.lat = pos.lat;
        a.lon = pos.lon;
        if (ort && !a.ort) a.ort = ort;
        break;
      }
    }
  }
  return { annonser: [...annonser.values()], slutpriser };
}

// Geokodningsfrågor per annons. Hemnet bär adressen i sin slug; Booli ger
// bara gatuadress, så vi provar den med varje bevakat område tillagt.
function byggFragor(a, areas) {
  if (a.adressFragor?.length) return a.adressFragor.map((fraga) => ({ fraga }));
  if (a.adress && areas.length) {
    return [...areas.map((ort) => ({ fraga: `${a.adress} ${ort}`, ort })), { fraga: a.adress }];
  }
  if (a.adress) return [{ fraga: a.adress }];
  return [];
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
    adressFragor: null,
    bild: null,
    pris: null,
    boarea: null,
    tomtarea: null,
    lat: null,
    lon: null,
  });

  // 1) Gå igenom alla <a>-taggar och para id ↔ adresstext ↔ bild
  for (const m of text.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = flerAvkoda(m[1]);
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

  const adressFragor = [...new Set([
    [...gata, ...plats].join(" "),
    [...gata, kommunNamn].filter(Boolean).join(" "),
    adressOrd.join(" "),
  ])].filter(Boolean);

  return {
    id: `hemnet-${id}`,
    kalla: "Hemnet",
    url: `https://www.hemnet.se/bostad/${slug}`,
    typ,
    rum: rum ? Number(rum.replace("rum", "")) : null,
    adress,
    ort: plats.map(cap).join(" "),
    adressFragor,
    bild: null,
    pris: null, boarea: null, tomtarea: null, lat: null, lon: null,
  };
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
