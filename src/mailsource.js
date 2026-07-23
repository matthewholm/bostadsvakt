// Läser bevakningsmejl från Hemnet och Booli i en egen inkorg (IMAP) och
// omvandlar dem till annonser i samma format som Booli-API:t levererar.
// Kräver IMAP_USER + IMAP_PASSWORD (och IMAP_HOST om inte Gmail).
import { geokoda } from "./geocode.js";

const paus = (ms) => new Promise((r) => setTimeout(r, ms));

export function harImap() {
  return Boolean(process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

export async function hamtaMailAnnonser() {
  // Dynamiska importer så att beroendena bara behövs när mejlkällan används.
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
    for (const fraga of a.adressFragor ?? []) {
      const pos = await geokoda(fraga);
      await paus(1100);
      if (pos) { a.lat = pos.lat; a.lon = pos.lon; break; }
    }
  }
  return [...annonser.values()];
}

// Hittar Hemnet-/Booli-länkar i mejltext (även procentkodade i spårningslänkar).
export function hittaAnnonser(text) {
  const avkodad = text + "\n" + safeDecode(text);
  const resultat = new Map();

  // Husbilder: i mejlens HTML ligger fotot oftast som <img> inuti samma
  // <a>-tagg som länkar till annonsen – para ihop bild med annons-id.
  const bilder = new Map();
  for (const m of avkodad.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1] + " " + safeDecode(m[1]);
    const img = m[2].match(/<img\b[^>]*src="(https?:\/\/[^"]+?)"/i)?.[1];
    if (!img || /logo|icon|spacer|pixel/i.test(img)) continue;
    const hemnetId = href.match(/hemnet\.se\/bostad\/[a-z0-9-]*?-(\d{6,})/)?.[1];
    if (hemnetId && !bilder.has(`hemnet-${hemnetId}`)) bilder.set(`hemnet-${hemnetId}`, img);
    const booliId = href.match(/booli\.se\/(?:annons|bostad)\/(\d+)/)?.[1];
    if (booliId && !bilder.has(`booli-${booliId}`)) bilder.set(`booli-${booliId}`, img);
  }

  for (const m of avkodad.matchAll(/https?:\/\/(?:www\.)?hemnet\.se\/bostad\/([a-z0-9-]+)/g)) {
    const a = tolkaHemnetSlug(m[1]);
    if (a) resultat.set(a.id, a);
  }
  for (const m of avkodad.matchAll(/https?:\/\/(?:www\.)?booli\.se\/(?:annons|bostad)\/(\d+)/g)) {
    resultat.set(`booli-${m[1]}`, {
      id: `booli-${m[1]}`,
      kalla: "Booli",
      url: `https://www.booli.se/annons/${m[1]}`,
      typ: "", adress: `Booli-annons ${m[1]}`, ort: "", adressFragor: [],
      pris: null, rum: null, boarea: null, tomtarea: null, lat: null, lon: null,
    });
  }
  for (const a of resultat.values()) a.bild = bilder.get(a.id) ?? null;
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
  const plats = ix >= 0 ? adressOrd.slice(0, ix) : []; // t.ex. ["raby","norrtalje"]
  const gata = ix >= 0 ? adressOrd.slice(ix + 1) : adressOrd; // t.ex. ["norrbyggebyvagen","31"]
  const kommunNamn = plats.at(-1) ?? "";

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const adress = [cap(gata.join(" ")), plats.map(cap).join(" ")].filter(Boolean).join(", ");

  // Geokodningsfrågor i fallande precision: gata + hela platsen, gata + kommun, hela sluggen
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
    pris: null, boarea: null, tomtarea: null, lat: null, lon: null,
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return ""; }
}
