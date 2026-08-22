// Mäklarens egen boendekalkyl – driftskostnad, lagfart, pantbrevsavgift,
// sådant Boolis egen sida sällan visar men mäklarens egen objektssida ofta
// gör. Boolis annonssida länkar till mäklarens (fältet "Läs mer hos
// mäklaren"), och den länken finns i Boolis rå HTML redan – ingen extra
// sida behöver besökas för att hitta den.
//
// Mäklarens egen sida är däremot inte statisk HTML. Den renderas av
// JavaScript (bekräftat: en vanlig fetch mot lansfast.se, en av flera
// varumärken byggda på Vitecs mäklarplattform, gav en tom sidskal på
// 2 kB – en riktig webbläsare gav 313 kB färdig text). Därför krävs en
// headless webbläsare (Playwright) för det här steget, till skillnad
// från annonsberikning.js som klarar sig med fetch.
//
// Bara Vitec-plattformen är bekräftad hittills (via connect-resolve.
// maklare.vitec.net-länken Booli ger). Andra mäklarplattformar – Svensk
// Fastighetsförmedling, Fastighetsbyrån, HusmanHagberg m.fl. – kan använda
// helt andra system, och funktionen känner inte igen dem: en ärlig lucka
// (ingen kalkyl) är rätt svar, inte en gissning på en sidstruktur som
// aldrig undersökts.
import { chromium } from "playwright";

const TIMEOUT_MS = 20_000;
// Backslash is deliberately allowed in the match (not excluded like the
// quote characters and whitespace that actually bound the link): Booli's
// JS-string-escaped copy of the link spells "&" as a six-character
// backslash-u-unicode escape, and excluding backslash from the match
// truncated right there, silently losing everything after the first
// "&" in the query string.
const VITEC_LANK = /https?:\/\/connect-resolve\.maklare\.vitec\.net\/[^\s"']+/;

/** Boolis rå HTML bär länken två gånger, en gång HTML-kodad
 *  (`&amp;`) och en gång JS-strängkodad (`\u0026`) – båda avkodas hit. */
export function hittaMaklarlank(html) {
  const m = html.match(VITEC_LANK);
  if (!m) return null;
  return m[0].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
}

/**
 * Plockar ut belopp ur mäklarsidans egen text, rad för rad efter etikett
 * – inte efter CSS-klass, som byter namn oftare än orden "Driftkostnad"
 * och "Lagfart" gör. Etiketten och beloppet sitter ihop utan mellanslag
 * i sidans textinnehåll ("Driftkostnad5 032 kr"), så \d\s* fångar både
 * det och den vanliga formen med mellanslag.
 */
export function tolkaMaklarkalkyl(text) {
  const belopp = (etikett) => {
    const m = text.match(new RegExp(`${etikett}\\s*([\\d\\s]+)\\s*kr\\b`));
    if (!m) return null;
    const n = Number(m[1].replace(/\s/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  return {
    driftkostnadManad: belopp("Driftkostnad"),
    lagfart: belopp("Lagfart"),
    amorteringManad: belopp("Amortering"),
  };
}

/** Never kastar – en okänd plattform eller ett fel lämnar bara fälten
 *  null, aldrig ett avbrutet husvarv. */
export async function hamtaMaklarkalkyl(maklarlank) {
  if (!maklarlank || !VITEC_LANK.test(maklarlank)) return null;
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(maklarlank, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
    const text = await page.innerText("body");
    return tolkaMaklarkalkyl(text);
  } catch {
    return null;
  } finally {
    await browser?.close();
  }
}
