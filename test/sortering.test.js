// Nätfria tester för husets sorteringsvärden i sida.json. Kör med `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { sorteringsvarden } from "../src/sortering.js";
import { kostnadsbild } from "../src/kostnader.js";
import { prisbedomning } from "../src/marknad.js";

const mal = { namn: "Alvik", hallplatsId: "9112" };
const hus = {
  id: "hemnet-1", pris: 2495000, boarea: 143, byggar: 1975, poang: 72,
  restidMin: 38, pendlingsmal: "Alvik", kommun: "Haninge", lan: "Stockholms län",
};
const marknad = {
  ar: "2025",
  kommuner: { Haninge: { kod: "0136", antal: 520, medelprisTkr: 5073, taxTkr: 4074, kt: 1.24 } },
  lan: { "Stockholms län": { kod: "01", ktAr: 1.26, kt: 1.3, manad: "2026M09" } },
};
const somKarta = (lista) => Object.fromEntries(lista.map((s) => [s.label, s.value]));

test("ett hus med fullt underlag får alla sex sorteringsvärden", () => {
  const uppgifter = { taxeringsvarde: 1900000 };
  const kostnad = kostnadsbild(hus, uppgifter);
  const pris = prisbedomning({ hus, uppgifter, marknad, kostnad });
  const v = somKarta(sorteringsvarden({ hus, kostnad, pris, mal }));
  assert.deepEqual(Object.keys(v), ["Matchning", "Pris", "Ålder", "Månadskostnad", "Restid till Alvik", "Pris mot uppskattning"]);
  assert.equal(v["Månadskostnad"], kostnad.manad.total);
  assert.equal(v["Restid till Alvik"], 38);
  assert.equal(v["Pris mot uppskattning"], Math.round(((2495000 - pris.varde) / pris.varde) * 100));
});

test("pris mot uppskattning är positivt över och negativt under, som raden i kortet", () => {
  const over = sorteringsvarden({ hus, pris: { varde: 2000000 }, mal });
  const under = sorteringsvarden({ hus, pris: { varde: 3000000 }, mal });
  assert.equal(somKarta(over)["Pris mot uppskattning"], 25);
  assert.equal(somKarta(under)["Pris mot uppskattning"], -17);
});

test("utan uppskattat värde, kostnad eller restid utelämnas värdet i stället för att bli 0", () => {
  const kostnad = kostnadsbild(hus);
  const pris = prisbedomning({ hus, marknad, kostnad });
  assert.equal(pris.varde, null);
  const v = somKarta(sorteringsvarden({ hus: { ...hus, restidMin: null }, kostnad, pris, mal }));
  assert.ok(!("Pris mot uppskattning" in v));
  assert.ok(!("Restid till Alvik" in v));
  assert.ok("Månadskostnad" in v);

  const utanPris = { ...hus, pris: null };
  const tom = somKarta(sorteringsvarden({ hus: utanPris, kostnad: kostnadsbild(utanPris), pris: null, mal }));
  assert.ok(!("Pris" in tom) && !("Månadskostnad" in tom));
});

test("restid mätt mot ett tidigare pendlingsmål sorteras inte ihop med de andra", () => {
  const gammal = { ...hus, pendlingsmal: "Stockholm C" };
  assert.ok(!sorteringsvarden({ hus: gammal, mal }).some((s) => s.label.startsWith("Restid")));
  // Hus från innan målet sparades på posten antas gälla dagens mål.
  const { pendlingsmal: _, ...utanMal } = hus;
  assert.equal(somKarta(sorteringsvarden({ hus: utanMal, mal }))["Restid till Alvik"], 38);
});

test("husuppgifternas byggår vinner över annonsens", () => {
  assert.equal(somKarta(sorteringsvarden({ hus, byggar: 1990, mal }))["Ålder"], 1990);
  assert.equal(somKarta(sorteringsvarden({ hus, mal }))["Ålder"], 1975);
});

test("varje värde är ett ändligt tal, annars vägrar Alva hela sidan", () => {
  const kostnad = kostnadsbild(hus, { taxeringsvarde: 1900000 });
  const pris = prisbedomning({ hus, uppgifter: { taxeringsvarde: 1900000 }, marknad, kostnad });
  for (const s of sorteringsvarden({ hus, kostnad, pris, mal })) {
    assert.equal(typeof s.label, "string");
    assert.ok(Number.isFinite(s.value), `${s.label}: ${s.value}`);
  }
});
