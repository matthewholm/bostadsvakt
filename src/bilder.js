// Plockar ut annonsens egna foton ur en sidas HTML. Körs både i motorn och i
// webbläsaren på klistra-in-sidan, så filen får inte importera något som
// bara finns i Node.
//
// Ingen kunskap om någon särskild sajt: bildadresserna letas upp överallt
// där en sida brukar lägga dem (img src, srcset, data-src, og:image och
// inbäddad JSON, där snedstreck ofta är kodade som /), och samma bild i
// flera storlekar slås ihop till den största. Hemnet, Booli och en
// mäklarsida skiljer sig i uppmärkning men inte i att deras foton är
// jpg/webp-adresser någonstans i sidan.

const BILDFIL = /\.(?:jpe?g|webp|png)(?:$|[?#])/i;
// Det som inte är husets foton: loggor, ikoner, mäklarporträtt, kartrutor.
// Ordet räcker, för en husbild heter aldrig "logo" i sin egen adress.
const INTE_HUSBILD = /logo|icon|favicon|sprite|avatar|placeholder|spacer|pixel|tracking|badge|flag|emoji|broker|agent|maklare|mäklare|employee|staff|portrait|profile|staticmap|maptile|tile\.|\/maps?\/|\.svg/i;

const avkoda = (s) =>
  s
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;|&#47;/gi, "/");

// En variant utan storleksuppgift är oftast sidans vanliga bild, inte en
// miniatyr: srcset brukar lista de mindre. Den räknas därför som medelstor,
// så att en 400w-miniatyr inte vinner över originalet bara för att den har
// ett tal och originalet inget.
const OKAND_STORLEK = 1000;

/** Storleken en adress själv avslöjar, för att välja den största varianten. */
function storleksTips(url, beskrivning) {
  const w = beskrivning?.match(/(\d{2,5})w/)?.[1];
  if (w) return Number(w);
  const dim = url.match(/(\d{3,5})x(\d{3,5})/);
  if (dim) return Math.max(Number(dim[1]), Number(dim[2]));
  const param = url.match(/[?&](?:w|width|size)=(\d{2,5})/i);
  if (param) return Number(param[1]);
  return OKAND_STORLEK;
}

/** Samma foto i olika storlekar ska räknas en gång: storleksdelarna tas bort
 *  ur nyckeln, resten av adressen är bildens identitet. */
function nyckel(url) {
  try {
    const u = new URL(url);
    const vag = u.pathname
      .replace(/\d{2,5}x\d{2,5}/g, "")
      .replace(/\/(?:thumb|thumbnail|small|medium|large|original|full|itemgallery_[a-z]+|cut|resize[^/]*)\//gi, "/")
      .replace(/[_-]+(?=\.)/g, "")
      .replace(/\/+/g, "/");
    return `${u.hostname}${vag}`.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Husets foton i den ordning sidan visar dem, som absoluta https-adresser.
 * `bas` är sidans egen adress, för relativa bildlänkar.
 */
export function hittaBilder(html, bas) {
  const text = avkoda(String(html ?? ""));
  const kandidater = [];
  const lagg = (rå, beskrivning) => {
    if (!rå) return;
    let url = rå.trim();
    if (url.startsWith("//")) url = "https:" + url;
    try {
      url = new URL(url, bas || undefined).href;
    } catch {
      return;
    }
    if (!/^https?:/i.test(url)) return;
    url = url.replace(/^http:/i, "https:");
    if (!BILDFIL.test(url) || INTE_HUSBILD.test(url)) return;
    kandidater.push({ url, storlek: storleksTips(url, beskrivning) });
  };

  for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
    const tagg = m[0];
    for (const attr of ["src", "data-src", "data-lazy-src", "data-original"]) {
      lagg(tagg.match(new RegExp(`\\s${attr}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1]);
    }
    const srcset = tagg.match(/\s(?:data-)?srcset\s*=\s*["']([^"']+)["']/i)?.[1];
    if (srcset) {
      for (const del of srcset.split(/,\s+/)) {
        const [url, beskrivning] = del.trim().split(/\s+/);
        lagg(url, beskrivning);
      }
    }
  }
  for (const m of text.matchAll(/<source\b[^>]*srcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const del of m[1].split(/,\s+/)) {
      const [url, beskrivning] = del.trim().split(/\s+/);
      lagg(url, beskrivning);
    }
  }
  for (const m of text.matchAll(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/gi)) {
    lagg(m[0].match(/content\s*=\s*["']([^"']+)["']/i)?.[1]);
  }
  // Inbäddad JSON och allt annat: varje citerad adress som slutar på en bildfil.
  for (const m of text.matchAll(/["'(]((?:https?:)?\/\/[^"'()\s<>]+?\.(?:jpe?g|webp|png)(?:\?[^"'()\s<>]*)?)["')]/gi)) {
    lagg(m[1]);
  }

  // En Map behåller platsen för en nyckel som skrivs över, så ordningen är
  // den då fotot först dök upp, även när en större variant hittas senare.
  const basta = new Map();
  for (const k of kandidater) {
    const n = nyckel(k.url);
    const forra = basta.get(n);
    if (!forra || k.storlek > forra.storlek) basta.set(n, k);
  }
  return [...basta.values()].map((k) => k.url);
}
