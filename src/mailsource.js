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
    if (a.adressFraga) {
      const pos = await geokoda(a.adressFraga);
      if (pos) { a.lat = pos.lat; a.lon = pos.lon; }
      await paus(1100);
    }
  }
  return [...annonser.values()];
}

// Hittar Hemnet-/Booli-länkar i mejltext (även procentkodade i spårningslänkar).
export function hittaAnnonser(text) {
  const avkodad = text + "\n" + safeDecode(text);
  const resultat = new Map();

  for (const m of avkodad.matchAll(/https?:\/\/(?:www\.)?hemnet\.se\/bostad\/([a-z0-9-]+)/g)) {
    const a = tolkaHemnetSlug(m[1]);
    if (a) resultat.set(a.id, a);
  }
  for (const m of avkodad.matchAll(/https?:\/\/(?:www\.)?booli\.se\/(?:annons|bostad)\/(\d+)/g)) {
    resultat.set(`booli-${m[1]}`, {
      id: `booli-${m[1]}`,
      kalla: "Booli",
      url: `https://www.booli.se/annons/${m[1]}`,
      typ: "", adress: `Booli-annons ${m[1]}`, ort: "", adressFraga: null,
      pris: null, rum: null, boarea: null, tomtarea: null, lat: null, lon: null,
    });
  }
  return [...resultat.values()];
}

// Hemnets adress-slug bär på mycket: "villa-6rum-rimbo-norrtalje-kommun-vallbyvagen-10-21398433"
export function tolkaHemnetSlug(slug) {
  const id = slug.match(/-(\d{6,})$/)?.[1];
  if (!id) return null;
  const delar = slug.replace(/-\d{6,}$/, "").split("-");
  const typ = delar.shift() ?? "";
  const rum = delar.find((d) => /^\d+rum$/.test(d));
  const adressOrd = delar.filter((d) => !/^\d+rum$/.test(d) && d !== "rum");
  const adress = adressOrd.join(" ");
  return {
    id: `hemnet-${id}`,
    kalla: "Hemnet",
    url: `https://www.hemnet.se/bostad/${slug}`,
    typ,
    rum: rum ? Number(rum.replace("rum", "")) : null,
    adress: adress.charAt(0).toUpperCase() + adress.slice(1),
    ort: "",
    adressFraga: adress,
    pris: null, boarea: null, tomtarea: null, lat: null, lon: null,
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return ""; }
}
