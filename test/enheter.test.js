// Nätfria enhetstester för de delar som gick fel: geokodningsspärren,
// län/biljettlogiken och matchningens redovisning.
//
// De här testerna kräver varken API-nycklar eller internet med flit – det är
// just den sortens logik som tyst kan gå sönder igen. Kör med `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifiera } from "../src/geocode.js";
import { myndighetForKommun, myndighetForOrt, kommunForOrt, biljettrad, visaKommun, SL, UL } from "../src/lan.js";
import { beraknaMatchning } from "../src/score.js";
import { turtathetPoang } from "../src/transit.js";

// ---------------------------------------------------------------------------
// Län och trafikbolag
// ---------------------------------------------------------------------------

test("Norrtälje ligger i Stockholms län och trafikeras av SL – inte UL", () => {
  const m = myndighetForKommun("Norrtälje");
  assert.equal(m, SL);
  assert.equal(m.lan, "Stockholms län");
  assert.notEqual(m.kod, "UL");
});

test("Uppsala kommun trafikeras av UL", () => {
  assert.equal(myndighetForKommun("Uppsala"), UL);
});

test("kommunnamn tolkas oavsett stavning, skiftläge och 'kommun'-suffix", () => {
  for (const variant of ["Norrtälje", "norrtalje", "NORRTÄLJE", "Norrtälje kommun", "Norrtälje Municipality"]) {
    assert.equal(myndighetForKommun(variant), SL, `misslyckades för "${variant}"`);
  }
});

test("orterna som placerades fel hör till Norrtälje kommun (SL-område)", () => {
  // Exakt de orter som i data/traffar.json fått koordinater uppe i Uppsala.
  for (const ort of ["Väddö", "Singö", "Älmsta", "Hallstavik", "Häverö", "Skebobruk", "Rimbo", "Riala", "Rånäs", "Gottröra", "Grovstanäs", "Syninge"]) {
    assert.equal(kommunForOrt(ort), "norrtalje", `${ort} borde höra till Norrtälje`);
    assert.equal(myndighetForOrt(ort).kod, "SL", `${ort} borde vara SL-område`);
  }
});

test("orterna i Uppsalabygden hör till UL-området", () => {
  for (const ort of ["Vänge", "Jumkil", "Storvreta", "Bälinge", "Vattholma", "Almunge", "Knutby", "Rasbokil"]) {
    assert.equal(myndighetForOrt(ort).kod, "UL", `${ort} borde vara UL-område`);
  }
});

test("kommuner utanför de två länen ger ingen myndighet", () => {
  // Trosa är dit ett hus felaktigt geokodades (latitud 59,09).
  for (const utanfor of ["Trosa", "Nyköping", "Västerås", "Gävle"]) {
    assert.equal(myndighetForKommun(utanfor), null);
  }
});

// ---------------------------------------------------------------------------
// Biljetter – kärnan i felrapporten
// ---------------------------------------------------------------------------

test("resa inom samma län kräver EN biljett, inte två", () => {
  const b = biljettrad(SL, SL);
  assert.equal(b.tvaBiljetter, false);
  assert.match(b.text, /En SL-biljett räcker/);
});

test("hus i Norrtälje till Stockholm C ger aldrig varning om två biljetter", () => {
  // Det var precis det här felet: "⚠ Flera trafikbolag (UL + SJ) – kan kräva
  // separata biljetter" för ett hus i Norrtälje. Norrtälje och Stockholm C
  // ligger båda i Stockholms län, alltså en SL-biljett.
  const husMyndighet = myndighetForOrt("Väddö");
  const b = biljettrad(husMyndighet, SL);
  assert.equal(b.tvaBiljetter, false);
  assert.doesNotMatch(b.text, /UL/);
  assert.doesNotMatch(b.text, /SJ/);
});

test("resa som korsar länsgränsen Uppsala–Stockholm kräver två biljetter", () => {
  const b = biljettrad(UL, SL);
  assert.equal(b.tvaBiljetter, true);
  assert.match(b.text, /länsgränsen/);
  assert.match(b.text, /UL \+ SL/);
});

// ---------------------------------------------------------------------------
// Geokodningsspärren – den som hade stoppat samtliga felplaceringar
// ---------------------------------------------------------------------------

const bas = { precision: "hus", kalla: "test", fraga: "testfråga" };

test("träff utan fastställd kommun avvisas istället för att gissa", () => {
  // Det gamla beteendet: ort saknas → acceptera blint. Nu: null.
  assert.equal(verifiera({ ...bas, lat: 59.86, lon: 17.43, kommun: null }), null);
});

test("träff utanför Uppsala/Stockholms län avvisas", () => {
  // 59,09/17,97 är dit "Norruddsvägen 6" hamnade – nere vid Trosa.
  assert.equal(verifiera({ ...bas, lat: 59.0966, lon: 17.9738, kommun: "trosa" }), null);
});

test("träff i fel kommun avvisas när annonsen säger något annat", () => {
  // "Backbyvägen 184, Singö" som landade i Uppsala.
  const r = verifiera({ ...bas, lat: 59.8169, lon: 17.7193, kommun: "uppsala", forvantadKommun: "norrtalje" });
  assert.equal(r, null);
});

test("korrekt träff accepteras och bär med sig kommun, län och trafikbolag", () => {
  const r = verifiera({ ...bas, lat: 59.7462, lon: 18.7734, kommun: "norrtalje", forvantadKommun: "norrtalje" });
  assert.ok(r, "träffen borde accepterats");
  assert.equal(r.kommunNamn, "Norrtälje");
  assert.equal(r.lan, "Stockholms län");
  assert.equal(r.myndighet, "SL");
  assert.equal(r.precision, "hus");
});

test("koordinater utanför rutan avvisas även med giltigt kommunnamn", () => {
  // Skydd mot att ett riktigt kommunnamn paras med en tokig koordinat.
  assert.equal(verifiera({ ...bas, lat: 55.6, lon: 13.0, kommun: "norrtalje" }), null);
});

test("visaKommun ger tillbaka korrekt stavning", () => {
  assert.equal(visaKommun("norrtalje"), "Norrtälje");
  assert.equal(visaKommun("osthammar"), "Östhammar");
});

// ---------------------------------------------------------------------------
// Matchningspoängen – "varför är 80 bättre än 20?"
// ---------------------------------------------------------------------------

const kriterier = {
  maxAvståndHållplatsM: 1000,
  maxRestidStockholmMin: 120,
  maxAvståndVattenM: 5000,
  maxAvståndSkogM: 1300,
  maxGrannarInom300m: 100,
  kravNatur: "något",
};

test("matchningen redovisar varje faktor med värde, delpoäng, vikt och bidrag", () => {
  const m = beraknaMatchning(kriterier, {
    hallplatsAvstand: 400, restidMin: 60, turtathetAvgangar: 20,
    vattenM: 1000, skogM: 300, grannar: 20,
  });
  assert.ok(m.poang > 0 && m.poang <= 100);
  assert.ok(m.delar.length >= 4);
  for (const d of m.delar) {
    assert.ok(d.namn, "faktorn ska ha ett namn");
    assert.ok(d.text, `faktorn ${d.namn} ska ha en läsbar förklaring`);
    assert.ok(d.delpoang >= 0 && d.delpoang <= 100);
    assert.ok(d.vikt > 0);
    assert.ok(d.bidrag <= d.maxBidrag + 0.05, "bidraget kan aldrig överstiga maxbidraget");
  }
  // Summan av bidragen ska vara poängen (avrundning tillåten).
  const summa = m.delar.reduce((s, d) => s + d.bidrag, 0);
  assert.ok(Math.abs(summa - m.poang) < 1.5, `summan ${summa} borde matcha poängen ${m.poang}`);
});

test("förklaringen namnger både starkaste och svagaste faktorn", () => {
  const m = beraknaMatchning(kriterier, {
    hallplatsAvstand: 950, restidMin: 115, turtathetAvgangar: 2,
    vattenM: 200, skogM: 100, grannar: 5,
  });
  assert.match(m.forklaring, /Starkast:/);
  assert.match(m.forklaring, /Svagast:/);
  assert.match(m.forklaring, /viktat snitt/);
});

test("ett bra läge får högre poäng än ett dåligt – och skillnaden går att peka på", () => {
  const bra = beraknaMatchning(kriterier, {
    hallplatsAvstand: 200, restidMin: 45, turtathetAvgangar: 40,
    vattenM: 300, skogM: 150, grannar: 5,
  });
  const daligt = beraknaMatchning(kriterier, {
    hallplatsAvstand: 980, restidMin: 118, turtathetAvgangar: 0,
    vattenM: 4900, skogM: 1280, grannar: 95,
  });
  assert.ok(bra.poang > daligt.poang + 40, `${bra.poang} borde vara klart högre än ${daligt.poang}`);
  // Varje faktor ska kunna jämföras rakt av mellan husen
  for (const del of bra.delar) {
    const motpart = daligt.delar.find((d) => d.nyckel === del.nyckel);
    assert.ok(motpart, `${del.namn} ska finnas i båda uträkningarna`);
    assert.ok(del.delpoang >= motpart.delpoang, `${del.namn} borde vara bättre i det bra huset`);
  }
});

test("saknade mått viktas bort proportionellt istället för att nollas", () => {
  // Bara naturdata: poängen ska spegla naturen, inte straffas för att
  // pendlings- och grannmått saknas.
  const m = beraknaMatchning(kriterier, { vattenM: 0, skogM: 0 });
  assert.equal(m.poang, 100);
  assert.ok(m.saknas.length > 0);
  assert.match(m.forklaring, /bortviktade/);
});

test("naturkravet 'något' belönar det bästa av vatten och skog", () => {
  const nara = beraknaMatchning({ ...kriterier, kravNatur: "något" }, { vattenM: 5000, skogM: 0 });
  const bada = beraknaMatchning({ ...kriterier, kravNatur: "båda" }, { vattenM: 5000, skogM: 0 });
  assert.equal(nara.poang, 100, "'något' ska ta bästa värdet");
  assert.equal(bada.poang, 50, "'båda' ska ta snittet");
});

// ---------------------------------------------------------------------------
// Turtäthet
// ---------------------------------------------------------------------------

test("ingen linjelagd trafik ger noll i turtäthetspoäng", () => {
  // Det är hela poängen med måttet: ett hus där bussen måste förbeställas
  // ska inte få samma pendlingspoäng som ett med kvartstrafik.
  assert.equal(turtathetPoang(0), 0);
});

test("turtäthetspoängen växer med antalet avgångar och toppar vid 40", () => {
  assert.ok(turtathetPoang(2) < turtathetPoang(10));
  assert.ok(turtathetPoang(10) < turtathetPoang(30));
  assert.equal(turtathetPoang(40), 100);
  assert.equal(turtathetPoang(200), 100, "poängen ska inte kunna överstiga 100");
});

test("turtätheten slår igenom i matchningen", () => {
  const matt = { hallplatsAvstand: 300, restidMin: 60, vattenM: 500, skogM: 200, grannar: 10 };
  const tat = beraknaMatchning(kriterier, { ...matt, turtathetAvgangar: 40 });
  const gles = beraknaMatchning(kriterier, { ...matt, turtathetAvgangar: 0 });
  assert.ok(tat.poang > gles.poang, "tät trafik ska ge högre matchning än ingen trafik alls");
});

// ---------------------------------------------------------------------------
// Geokodningens kommunlåsning (med stubbad fetch – inget nätverk)
//
// Det här är den viktigaste regressionen att skydda: när annonsen säger vilken
// kommun huset ligger i får uppslaget ALDRIG falla tillbaka på ett bredare
// bevakningsområde och acceptera en träff i fel kommun. Det var så Roslagen
// hamnade i Uppsala – först via den gamla ort-lösa fallbacken, och nästan igen
// via kandidatlistans breda områden.
// ---------------------------------------------------------------------------

import { geokoda } from "../src/geocode.js";

function stubbaFetch(svar) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => svar(String(url)),
  });
  return () => { globalThis.fetch = original; };
}

const NOMINATIM_UPPSALA = [{
  lat: "59.8169", lon: "17.7193", addresstype: "house",
  address: { municipality: "Uppsala kommun", county: "Uppsala län", town: "Uppsala" },
}];
const PHOTON_UPPSALA = {
  features: [{
    geometry: { coordinates: [17.7193, 59.8169] },
    properties: { county: "Uppsala kommun", state: "Uppsala län", city: "Uppsala", osm_value: "house" },
  }],
};

test("annonsens kommun låser uppslaget – en Uppsala-träff accepteras aldrig för ett hus på Väddö", async () => {
  // Varje geokodare svarar envist "Uppsala", precis som när gatunamnet råkar
  // finnas där också. Rätt svar är att ge upp, inte att ta Uppsala-träffen.
  const aterstall = stubbaFetch((url) =>
    url.includes("photon") ? PHOTON_UPPSALA : NOMINATIM_UPPSALA);
  try {
    const pos = await geokoda("Backbyvägen 184", {
      ort: "Singö",
      kommunText: "Norrtälje kommun",
      omraden: ["Uppsala", "Norrtälje"], // ska inte ens provas när kommunen är känd
    });
    assert.equal(pos, null, "hellre ingen plats alls än en nål i fel kommun");
  } finally {
    aterstall();
  }
});

test("en träff i rätt kommun accepteras och bär med sig SL som trafikbolag", async () => {
  const aterstall = stubbaFetch(() => [{
    lat: "60.1694", lon: "18.7934", addresstype: "house",
    address: { municipality: "Norrtälje kommun", county: "Stockholms län", village: "Väddö" },
  }]);
  try {
    const pos = await geokoda("Simpnäsvägen 13", { ort: "Väddö", kommunText: "Norrtälje kommun" });
    assert.ok(pos, "träffen borde accepterats");
    assert.equal(pos.kommunNamn, "Norrtälje");
    assert.equal(pos.myndighet, "SL");
    assert.equal(pos.lan, "Stockholms län");
    assert.ok(Math.abs(pos.lat - 60.1694) < 0.001);
  } finally {
    aterstall();
  }
});

test("utan känd kommun får de breda bevakningsområdena användas", async () => {
  // Booli-annonser saknar ibland ort helt. Då är det rimligt att prova
  // bevakningsområdena – men träffen måste fortfarande verifieras mot en
  // kommun i bevakade län.
  const aterstall = stubbaFetch(() => NOMINATIM_UPPSALA);
  try {
    const pos = await geokoda("Månskensvägen 32", { omraden: ["Uppsala", "Norrtälje"] });
    assert.ok(pos, "en verifierad Uppsala-träff är giltig när annonsen inte sagt något annat");
    assert.equal(pos.kommunNamn, "Uppsala");
    assert.equal(pos.myndighet, "UL");
  } finally {
    aterstall();
  }
});
