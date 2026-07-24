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

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: 993,
    secure: true,
    logger: false,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
  });

  const annonser = new Map();
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

      const text = (mail.html || "") + "\n" + (mail.text || "");
      for (const a of hittaAnnonser(text)) annonser.set(a.id, a);
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
  return [...annonser.values()];
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
// länken, ev. dubbel-kodad i en spårningslänk) med adress och bild.
export function hittaAnnonser(text) {
  const resultat = new Map();

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
  const avkodad = flerAvkoda(text);
  for (const m of avkodad.matchAll(/booli\.se\/annons\/(\d+)/g)) {
    if (!resultat.has(`booli-${m[1]}`)) resultat.set(`booli-${m[1]}`, nyBooli(m[1]));
  }
  for (const m of avkodad.matchAll(/hemnet\.se\/bostad\/([a-z0-9-]+)/gi)) {
    const bas = tolkaHemnetSlug(m[1]);
    if (bas && !resultat.has(bas.id)) resultat.set(bas.id, bas);
  }
  return [...resultat.values()];
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
  const adress = [cap(gata.join(" ")), plats.map(cap).join(" ")].filter(Boolean).join(", ");

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
