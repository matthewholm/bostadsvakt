// Nätfria tester för kostnadsbilden, mäklarfrågorna, tolkningen av
// inklistrade objektbeskrivningar och prisbedömningen. Kör med `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { kostnadsbild, kostnadsSektioner, fastighetsavgiftAr, pantbrevBehov } from "../src/kostnader.js";
import { fragorTillMaklaren, kandaUppgifter, vattenAvstand } from "../src/fragor.js";
import { tolkaObjektsida, tolkaPantbrev, hittaHus } from "../src/objektsida.js";
import { objektsidaIMejl } from "../src/mailsource.js";
import { prisbedomning, aktuelltKt } from "../src/marknad.js";

const hus = {
  id: "hemnet-1", adress: "Häckgränd 8", pris: 2495000, boarea: 143, rum: 5,
  kommun: "Haninge", lan: "Stockholms län", omgivning: ["Vatten: ca 250 m · Skog: ca 90 m"],
};
const marknad = {
  ar: "2025",
  kommuner: { Haninge: { kod: "0136", antal: 520, medelprisTkr: 5073, taxTkr: 4074, kt: 1.24 } },
  lan: { "Stockholms län": { kod: "01", ktAr: 1.26, kt: 1.3, manad: "2026M09" } },
};
// toLocaleString("sv-SE") skriver tusentalen med hårt mellanslag; testerna
// jämför med vanligt för läsbarhetens skull.
const ns = (s) => s.replace(/ /g, " ");
const allaRader = (sektioner) => sektioner.flatMap((s) => s.rader).map(ns);
const bedom = (arg) => {
  const p = prisbedomning(arg);
  return p && { ...p, rader: p.rader.map(ns) };
};

// ---------------------------------------------------------------------------
// Kostnader
// ---------------------------------------------------------------------------

test("utan hushållsekonomi räknas minsta kontantinsats, 10 %", () => {
  const k = kostnadsbild(hus);
  assert.equal(k.kontantinsats, 249500);
  assert.equal(k.lan, 2245500);
  assert.equal(k.lagfart.total, Math.round(2495000 * 0.015) + 825);
});

test("okända pantbrev räknas som inga alls, kända dras av från lånet", () => {
  assert.equal(pantbrevBehov({ lan: 2000000, befintliga: null }).nytt, 2000000);
  const kand = pantbrevBehov({ lan: 2000000, befintliga: 1500000 });
  assert.equal(kand.nytt, 500000);
  assert.equal(kand.kostnad.total, 10000 + 375);
  assert.equal(pantbrevBehov({ lan: 2000000, befintliga: 2500000 }).kostnad.total, 0);
});

test("fastighetsavgiften: taket utan taxeringsvärde, 0,75 % med, avgiftsfri för nybyggt", () => {
  assert.equal(fastighetsavgiftAr({}).kr, 10425);
  assert.equal(fastighetsavgiftAr({ taxeringsvarde: 1000000 }).kr, 7500);
  assert.equal(fastighetsavgiftAr({ taxeringsvarde: 3000000 }).kr, 10425);
  assert.equal(fastighetsavgiftAr({ byggar: 2020, iAr: 2026 }).kr, 0);
  assert.equal(fastighetsavgiftAr({ byggar: 2005, iAr: 2026 }).kalla, "tak");
});

test("husets egen driftkostnad vinner över schablonen", () => {
  const k = kostnadsbild(hus, { driftskostnadManad: 3000 });
  assert.equal(k.manad.drift.kalla, "kand");
  assert.equal(kostnadsbild(hus).manad.drift.kalla, "schablon");
});

test("kostnadsraderna är korta nog för Alva och börjar aldrig med en slutsatsmarkering", () => {
  const rader = allaRader(kostnadsSektioner(kostnadsbild(hus, { pantbrev: 800000, tomtrattsavgaldAr: 12000 })));
  for (const r of rader) {
    assert.ok(r.length <= 120, `för lång: ${r}`);
    assert.ok(!/^[✓⚠]/.test(r), `slutsatsmarkering: ${r}`);
  }
  assert.ok(rader.some((r) => r.startsWith("Tomträttsavgäld: 1 000 kr/mån")));
});

// ---------------------------------------------------------------------------
// Frågor till mäklaren
// ---------------------------------------------------------------------------

test("frågorna försvinner när svaret finns", () => {
  const fore = fragorTillMaklaren(hus, {}).map(ns);
  const efter = fragorTillMaklaren(hus, { pantbrev: 1000000, taxeringsvarde: 1900000, byggar: 1990 }).map(ns);
  assert.ok(fore.some((f) => /pantbrev/.test(f)));
  assert.ok(!efter.some((f) => /pantbrev/.test(f)));
  assert.ok(!efter.some((f) => /taxeringsvärdet\?/.test(f)));
  assert.ok(efter.length < fore.length);
});

test("byggår 1929–1975 ger blåbetongfrågan, nära vatten ger strandskyddsfrågan", () => {
  const f = fragorTillMaklaren(hus, { byggar: 1968 }).map(ns);
  assert.ok(f.some((x) => /blåbetong/.test(x)));
  assert.ok(f.some((x) => /grund har huset\? Hus från 1968/.test(x)));
  assert.ok(f.some((x) => /strandskydd/.test(x)));
  assert.equal(vattenAvstand(hus), 250);
});

test("tomträtt utan känd avgäld ger en egen fråga, och frågorna är numrerade och korta", () => {
  const f = fragorTillMaklaren({ ...hus, prisSankning: { fran: 2795000, till: 2495000 } }, { upplatelseform: "Tomträtt" }).map(ns);
  assert.ok(f.some((x) => /tomträttsavgälden/.test(x)));
  assert.ok(f.some((x) => /sänktes från 2 795 000 kr/.test(x)));
  f.forEach((x, i) => {
    assert.ok(x.startsWith(`${i + 1}. `));
    assert.ok(x.length <= 120, `för lång: ${x}`);
  });
});

// ---------------------------------------------------------------------------
// Inklistrade objektbeskrivningar
// ---------------------------------------------------------------------------

test("Hemnets objektsida: etikett och värde på var sin rad", () => {
  const text = [
    "Häckgränd 8", "Tungelsta, Haninge kommun", "2 495 000 kr",
    "Upplåtelseform", "Äganderätt", "Byggår", "1974", "Driftkostnad", "52 800 kr/år",
    "Energiklass", "E", "Pris/m²", "17 448 kr/m²",
  ].join("\n");
  const u = tolkaObjektsida(text);
  assert.equal(u.upplatelseform, "Äganderätt");
  assert.equal(u.byggar, 1974);
  assert.equal(u.driftskostnadManad, 4400);
  assert.equal(u.energiklass, "E");
});

test("priset: ensam rad hos Hemnet, med etikett hos mäklaren, aldrig pris per m²", () => {
  const hemnet = "Meny\n  Häckgränd 8  \n  Tungelsta, Haninge kommun\n   2 495 000 kr  \nPris/m²\n17 448 kr/m²\nLiknande\n3 100 000 kr";
  assert.equal(tolkaObjektsida(hemnet).pris, 2495000);
  assert.equal(tolkaObjektsida("Utgångspris: 3 195 000 kr\nTaxeringsvärde 2 000 000 kr").pris, 3195000);
  assert.equal(tolkaObjektsida("Pris/m²\n17 448 kr/m²").pris, undefined);
});

test("mäklarens objektbeskrivning: pantbrev, taxeringsvärde, VA och uppvärmning", () => {
  const text = [
    "Fastighetsbeteckning: Haninge Tungelsta 1:234",
    "Taxeringsvärde 2025: 1 950 000 kr (varav byggnad 1 200 000 kr)",
    "Pantbrev: 4 st, totalt 1 850 000 kr",
    "Uppvärmning: Bergvärme (2015)",
    "Vatten och avlopp: Kommunalt",
    "Samfällighet: Tungelsta vägförening, 1 200 kr/år",
  ].join("\n");
  const u = tolkaObjektsida(text);
  assert.equal(u.taxeringsvarde, 1950000);
  assert.equal(u.pantbrev, 1850000);
  assert.equal(u.pantbrevAntal, 4);
  assert.equal(u.uppvarmning, "Bergvärme (2015)");
  assert.equal(u.va, "Kommunalt");
  assert.equal(u.samfallighetAr, 1200);
  assert.equal(u.fastighetsbeteckning, "Haninge Tungelsta 1:234");
});

test("mäklarkalkylens kostnad för nya pantbrev läses inte som befintliga pantbrev", () => {
  assert.deepEqual(tolkaPantbrev("Boendekalkyl\nLagfart 37 425 kr\nPantbrev 43 291 kr\nRänta 5 900 kr/mån"), {});
  assert.deepEqual(tolkaPantbrev("Kostnad för nya pantbrev: 43 291 kr"), {});
  assert.deepEqual(tolkaPantbrev("Inga pantbrev finns uttagna."), { pantbrev: 0, pantbrevAntal: 0 });
  assert.equal(tolkaPantbrev("Inteckningar: 3 pantbrev om totalt 900 000 kr").pantbrev, 900000);
});

test("ett handskrivet mejl med en uppgift räcker, en söksida med kort gör det inte", () => {
  const hand = objektsidaIMejl({ text: "Häckgränd 8\npantbrev 1 200 000 kr", subject: "" }, 0);
  assert.equal(hand.fakta.pantbrev, 1200000);
  assert.equal(objektsidaIMejl({ text: "Byggår 1950", subject: "" }, 12), null);
});

test("rätt hus hittas: ämnesraden först, annars adressen som står tidigast", () => {
  const flode = [hus, { id: "hemnet-2", adress: "Häckgränd 12" }, { id: "hemnet-3", adress: "Lärkvägen 3" }];
  assert.equal(hittaHus("…", "Uppgifter Häckgränd 12", flode).id, "hemnet-2");
  assert.equal(hittaHus("Meny\nHäckgränd 8\n…\nLiknande bostäder\nLärkvägen 3", "", flode).id, "hemnet-1");
  // "Häckgränd 8" får inte matcha inne i "Häckgränd 82"
  assert.equal(hittaHus("Häckgränd 82, Tungelsta", "", flode), null);
});

test("kandaUppgifter listar bara det som finns", () => {
  assert.deepEqual(kandaUppgifter({ byggar: 1974, pantbrev: 500000, pantbrevAntal: 2 }).map(ns), [
    "Pantbrev: 2 st, totalt 500 000 kr", "Byggår: 1974",
  ]);
});

// ---------------------------------------------------------------------------
// Prisbedömning
// ---------------------------------------------------------------------------

test("kommunens K/T justeras med länets senaste förändring", () => {
  const kt = aktuelltKt(marknad, "Haninge", "Stockholms län");
  assert.ok(Math.abs(kt.kt - (1.24 * 1.3) / 1.26) < 1e-9);
});

test("med taxeringsvärde: uppskattat värde och om utgångspriset är lågt", () => {
  const p = bedom({ hus, uppgifter: { taxeringsvarde: 2200000 }, marknad, kostnad: kostnadsbild(hus), maxPris: 4000000 });
  assert.ok(p.varde > 2800000 && p.varde < 2850000);
  assert.ok(p.rader.some((r) => /under uppskattningen: räkna med budgivning/.test(r)));
  assert.ok(p.rader.some((r) => r === "Förslag på första bud: utgångspriset, 2 495 000 kr"));
  assert.ok(p.rader.some((r) => /^Förslag på smärtgräns: 2 825 000 kr/.test(r)));
});

test("högt satt pris ger ett första bud under utgångspriset, maxgränsen tak för smärtgränsen", () => {
  const p = bedom({ hus: { ...hus, pris: 3500000 }, uppgifter: { taxeringsvarde: 2200000 }, marknad, maxPris: 4000000 });
  assert.ok(p.rader.some((r) => /utrymme att bjuda under/.test(r)));
  assert.ok(p.rader.some((r) => /^Förslag på första bud: 2 675 000 kr, under utgångspriset/.test(r)));
  const lag = bedom({ hus, uppgifter: { taxeringsvarde: 3500000 }, marknad, maxPris: 4000000 });
  assert.ok(lag.rader.some((r) => /^Förslag på smärtgräns: 4 000 000 kr, er maxgräns/.test(r)));
  assert.ok(lag.rader.some((r) => /räkna med att andra bjuder högre/.test(r)));
});

test("utan taxeringsvärde: inget påhittat värde, men vilket taxeringsvärde priset motsvarar", () => {
  const p = bedom({ hus, marknad });
  assert.equal(p.varde, null);
  assert.ok(p.rader.some((r) => /motsvarar ett taxeringsvärde på ca 1 950 000 kr/.test(r)));
  assert.ok(p.rader.some((r) => /^Smärtgräns: be mäklaren om taxeringsvärdet/.test(r)));
  for (const r of p.rader) assert.ok(r.length <= 120, `för lång: ${r}`);
});

test("utan SCB-data och utan taxeringsvärde blir det bara budråden kvar, inget kraschar", () => {
  const p = bedom({ hus, marknad: null });
  assert.ok(p.rader.length >= 2);
  assert.equal(bedom({ hus: { ...hus, pris: null }, marknad }), null);
});

// ---------------------------------------------------------------------------
// Pendlingsmål
// ---------------------------------------------------------------------------

test("pendlingsmålet är Stockholm C tills config säger annat, och ett halvt ifyllt mål ignoreras", async () => {
  const { pendlingsmal, PENDLINGSMAL_STANDARD } = await import("../src/transit.js");
  assert.equal(pendlingsmal({}).namn, "Stockholm C");
  assert.equal(pendlingsmal({ pendlingsmal: { namn: "Alvik" } }), PENDLINGSMAL_STANDARD);
  const alvik = { namn: "Alvik", lat: 59.3334, lon: 17.9823 };
  assert.equal(pendlingsmal({ pendlingsmal: alvik }), alvik);
});

test("matchningen säger vilket mål restiden gäller", async () => {
  const { beraknaMatchning } = await import("../src/score.js");
  const k = { maxRestidStockholmMin: 90, pendlingsmal: { namn: "Alvik", lat: 59.3334, lon: 17.9823 } };
  const m = beraknaMatchning(k, { restidMin: 60 });
  assert.ok(m.delar.some((d) => d.namn === "Restid till Alvik"));
});
