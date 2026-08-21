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
import {
  beraknaLagfart, beraknaPantbrev, amorteringsprocent, driftskostnadManad,
  totalkostnad, levnadsomkostnad, kalp, saljaNuvarandeBostad, harRad,
} from "../src/ekonomi.js";
import { arBooliAnnons, tolkaBooliannons } from "../src/annonsberikning.js";

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

// ---------------------------------------------------------------------------
// Bil till hållplatsen
//
// För hus där enda trafiken är anropsstyrd är frågan inte "finns en hållplats"
// utan "hur tar jag mig härifrån på riktigt". Poängen ska då spegla den
// hållplats man faktiskt kliver på – men att köra dit kostar tid, och det får
// inte försvinna i en siffra som ser lika bra ut som gångavstånd.
// ---------------------------------------------------------------------------

import { parkeringstext } from "../src/bil.js";

test("bil till hållplatsen ger poäng, men mindre än samma trafik vid dörren", () => {
  const matt = { hallplatsAvstand: 900, vattenM: 500, skogM: 200, grannar: 10 };
  const viddorren = beraknaMatchning(kriterier, { ...matt, turtathetAvgangar: 30 });
  const medBil = beraknaMatchning(kriterier, { ...matt, turtathetAvgangar: 30, bilTillHallplatsMin: 15 });
  const ingenTrafik = beraknaMatchning(kriterier, { ...matt, turtathetAvgangar: 0 });

  assert.ok(medBil.poang < viddorren.poang, "körtiden ska kosta något");
  assert.ok(medBil.poang > ingenTrafik.poang, "bil dit är bättre än ingen trafik alls");
});

test("längre bilresa ger lägre poäng, men aldrig under 40 % av trafiken", () => {
  const matt = { hallplatsAvstand: 900, turtathetAvgangar: 40, vattenM: 500, skogM: 200, grannar: 10 };
  const del = (min) => beraknaMatchning(kriterier, { ...matt, bilTillHallplatsMin: min })
    .delar.find((d) => d.nyckel === "turtathet").delpoang;

  assert.ok(del(5) > del(20), "fem minuter ska slå tjugo");
  assert.ok(del(20) > del(35), "tjugo ska slå trettiofem");
  // Golvet finns för att bil till pendeltåget är ett fungerande sätt att
  // pendla – inte likvärdigt med gångavstånd, men inte heller "ingen trafik".
  assert.ok(del(35) >= 40, `${del(35)} borde inte falla under golvet 40`);
});

test("faktorn heter något annat när man måste köra dit", () => {
  const matt = { hallplatsAvstand: 900, turtathetAvgangar: 20, vattenM: 500, skogM: 200, grannar: 10 };
  const utan = beraknaMatchning(kriterier, matt).delar.find((d) => d.nyckel === "turtathet");
  const med = beraknaMatchning(kriterier, { ...matt, bilTillHallplatsMin: 12 })
    .delar.find((d) => d.nyckel === "turtathet");

  assert.equal(utan.namn, "Turtäthet");
  assert.equal(med.namn, "Turtäthet (via bil)");
  // Förklaringen ska säga att siffran gäller en hållplats man kör till, annars
  // ser den ut som om bussen gick utanför dörren.
  assert.match(med.text, /kör till/);
  assert.match(med.text, /12 min bil/);
});

test("parkeringstexten säger 'avgift okänd' istället för att gissa gratis", () => {
  // OSM saknar ofta fee-taggen på landsbygden. I praktiken är den nästan alltid
  // gratis – men nästan är inte samma sak som är, och det är användarens pengar.
  assert.match(parkeringstext({ namn: "P", avstand: 50, gratis: null }), /avgift okänd/);
  assert.match(parkeringstext({ namn: "P", avstand: 50, gratis: true }), /gratis/);
  assert.match(parkeringstext({ namn: "P", avstand: 50, gratis: false }), /avgift/);
  assert.equal(parkeringstext(null), null);
});

test("infartsparkering lyfts fram framför ett generiskt parkeringsnamn", () => {
  const t = parkeringstext({ namn: "Parkering", avstand: 80, gratis: true, infartsparkering: true, platser: 40 });
  assert.match(t, /Infartsparkering/);
  assert.match(t, /40 platser/);
  assert.match(t, /80 m från hållplatsen/);
});

// ---------------------------------------------------------------------------
// Ekonomi – lagfart, pantbrev, amorteringskrav, KALP och har-vi-råd
//
// Lagfarts- och pantbrevsexemplen är samma räkneexempel källorna själva ger
// (3 000 000 kr köp → 45 825 kr, 1 000 000 kr nytt pantbrev → 20 375 kr),
// så testet dubbelkollar formeln mot en känd facit, inte bara mot sig självt.
// ---------------------------------------------------------------------------

test("lagfart är 1,5 % av köpeskillingen plus 825 kr expeditionsavgift", () => {
  const l = beraknaLagfart(3_000_000);
  assert.equal(l.stampelskatt, 45_000);
  assert.equal(l.expedition, 825);
  assert.equal(l.total, 45_825);
});

test("lagfart utan känt pris ger null istället för att gissa", () => {
  assert.equal(beraknaLagfart(null), null);
  assert.equal(beraknaLagfart(0), null);
});

test("pantbrev är 2 % av beloppet plus 375 kr expeditionsavgift", () => {
  const p = beraknaPantbrev(1_000_000);
  assert.equal(p.stampelskatt, 20_000);
  assert.equal(p.expedition, 375);
  assert.equal(p.total, 20_375);
});

test("inget lån kräver inget nytt pantbrev", () => {
  assert.deepEqual(beraknaPantbrev(0), { stampelskatt: 0, expedition: 0, total: 0 });
  assert.deepEqual(beraknaPantbrev(null), { stampelskatt: 0, expedition: 0, total: 0 });
});

test("amorteringskravet efter reformen 2026-04-01: 2/1/0 % på belåningsgradstrappan", () => {
  // Exakt på gränserna: >70 % ger 2, 50–70 % ger 1, ==50 % ger redan 0.
  assert.equal(amorteringsprocent(0.71), 2);
  assert.equal(amorteringsprocent(0.70), 1, "exakt 70 % ska ännu inte ge 2 %");
  assert.equal(amorteringsprocent(0.51), 1);
  assert.equal(amorteringsprocent(0.50), 0, "exakt 50 % ska inte kräva amortering");
  assert.equal(amorteringsprocent(0.30), 0);
});

test("driftskostnad från annonsen vinner alltid över schablonen", () => {
  const kand = driftskostnadManad({ kandKrManad: 5872, boarea: 105 });
  assert.equal(kand.kr, 5872);
  assert.equal(kand.kalla, "annons");

  const gissad = driftskostnadManad({ kandKrManad: null, boarea: 120, schablonKvmAr: 400 });
  assert.equal(gissad.kr, Math.round((120 * 400) / 12));
  assert.equal(gissad.kalla, "schablon");
});

test("driftskostnad utan boarea och utan känt värde ger null, inte en gissning ur luften", () => {
  assert.equal(driftskostnadManad({ kandKrManad: null, boarea: null }), null);
});

test("totalkostnad slår ihop ränta, amortering och drift till en månadskostnad, idag och stresstestat", () => {
  const t = totalkostnad({
    pris: 3_000_000,
    kontantinsats: 450_000, // 15 % kontantinsats → 85 % belåning → 2 % amortering
    boarea: 100,
    driftskostnadKandKrManad: 3000,
    hushall: { antagande: { ranta: 4, kalkylranta: 8, driftskostnadKvmAr: 400 } },
  });
  assert.equal(t.lan, 2_550_000);
  assert.equal(t.belaningsgradProcent, 85);
  assert.equal(t.amorteringsprocent, 2);
  assert.equal(t.drift.kalla, "annons");
  assert.equal(t.manad.drift, 3000);
  assert.equal(t.manad.total, t.manad.ranta + t.manad.amortering + t.manad.drift);
  assert.equal(t.manadStress.total, t.manadStress.ranta + t.manadStress.amortering + t.manadStress.drift);
  assert.ok(t.manadStress.total > t.manad.total, "stresstestad kostnad ska vara högre än dagens");
  assert.equal(t.engangskostnad, t.lagfart.total + t.pantbrev.total);
});

test("levnadsomkostnad räknar Konsumentverkets 2026-belopp per vuxen och barnets ålder", () => {
  assert.equal(levnadsomkostnad({ vuxna: 2, barnAldrar: [] }), 2 * (3600 + 700 + 850 + 700 + 450));
  const medBarn = levnadsomkostnad({ vuxna: 2, barnAldrar: [5, 12] });
  assert.equal(medBarn, 2 * (3600 + 700 + 850 + 700 + 450) + 2000 + 3000);
});

test("KALP utan känd inkomst ger null, inte en falsk marginal", () => {
  assert.equal(kalp({ nettoinkomstManad: null, boendekostnadManad: 20_000 }), null);
});

test("KALP räknar kvar-att-leva-på rakt av", () => {
  const k = kalp({
    nettoinkomstManad: 45_000,
    boendekostnadManad: 20_000,
    ovrigaLanManad: 2_000,
    hushall: { vuxna: 2, barnAldrar: [] },
  });
  assert.equal(k.levnadsomkostnad, 2 * (3600 + 700 + 850 + 700 + 450));
  assert.equal(k.kvarAttLevaPa, 45_000 - 20_000 - 2_000 - k.levnadsomkostnad);
});

test("nettolikvid vid försäljning drar av kvarstående lån och mäklarkostnad", () => {
  const s = saljaNuvarandeBostad({ varde: 4_000_000, kvarstaendeLan: 1_500_000, maklarkostnadProcent: 3 });
  assert.equal(s.maklarkostnad, 120_000);
  assert.equal(s.nettoLikvid, 4_000_000 - 1_500_000 - 120_000);
});

test("nettolikvid kan aldrig bli negativ – ett hus värt mindre än lånet ger 0, inte minus", () => {
  const s = saljaNuvarandeBostad({ varde: 1_000_000, kvarstaendeLan: 1_500_000, maklarkostnadProcent: 3 });
  assert.equal(s.nettoLikvid, 0);
});

test("har-råd-bedömningen är 'okänt', inte ett gissat nej, när hushållsekonomin inte är ifylld", () => {
  const r = harRad({ pris: 3_000_000, boarea: 100, hushall: {} });
  assert.equal(r.verdikt, "okant");
  assert.match(r.forklaring, /inte ifylld/);
});

test("ett hushåll med god marginal får verdikt 'ja' med en läsbar förklaring", () => {
  const r = harRad({
    pris: 2_000_000,
    boarea: 90,
    driftskostnadKandKrManad: 2000,
    hushall: {
      nettoinkomstManad: 60_000,
      kontantinsatsTillgangligt: 1_000_000,
      vuxna: 2,
      barnAldrar: [],
      antagande: { ranta: 3.2, kalkylranta: 6 },
    },
  });
  assert.equal(r.verdikt, "ja");
  assert.match(r.forklaring, /kvar per månad/);
});

test("ett hushåll med underskott vid stresstestad ränta får verdikt 'nej'", () => {
  const r = harRad({
    pris: 6_000_000,
    boarea: 150,
    driftskostnadKandKrManad: 6000,
    hushall: {
      nettoinkomstManad: 35_000,
      kontantinsatsTillgangligt: 300_000,
      vuxna: 2,
      barnAldrar: [4, 7],
      antagande: { ranta: 3.2, kalkylranta: 8 },
    },
  });
  assert.equal(r.verdikt, "nej");
  assert.match(r.forklaring, /underskott/);
});

// ---------------------------------------------------------------------------
// Berikning från Boolis annonssida
//
// HTML-utdraget nedan är den verkliga strukturen Boolis annonssida bäddar in
// (verifierat mot en riktig annons, se annonsberikning.js) – inte påhittad
// markup, för ett test mot fantasi-HTML bevisar bara att regexen matchar sig
// själv.
// ---------------------------------------------------------------------------

const EXEMPEL_HTML =
  '{"__typename":"KeyPoint","key":"constructionYear","label":"Byggår","value":{"__typename":"DisplayText","plainText":"1962","markdown":"**1962**"}}' +
  '{"__typename":"InfoPoint","key":"operatingCost","displayText":{"__typename":"DisplayText","markdown":"Driftskostnaden är **5 872** kr/mån"}}';

test("tolkar byggår och driftskostnad ur Boolis inbäddade annonsdata", () => {
  const r = tolkaBooliannons(EXEMPEL_HTML);
  assert.equal(r.byggar, 1962);
  assert.equal(r.driftskostnadManad, 5872);
});

test("driftskostnad angiven per år räknas om till per månad", () => {
  const html = '{"key":"operatingCost","displayText":{"markdown":"Driftskostnaden är **60 000** kr/år"}}';
  assert.equal(tolkaBooliannons(html).driftskostnadManad, 5000);
});

test("saknas fälten helt blir svaret null, inte ett fel", () => {
  const r = tolkaBooliannons("<html>en annons utan inbäddad data</html>");
  assert.equal(r.byggar, null);
  assert.equal(r.driftskostnadManad, null);
});

test("bara Booli-annonser (booli.se-url) plockas ut för berikning, aldrig Hemnet", () => {
  assert.equal(arBooliAnnons({ id: "booli-123", url: "https://www.booli.se/annons/123" }), true);
  assert.equal(arBooliAnnons({ id: "hemnet-456", url: "https://www.hemnet.se/bostad/456" }), false);
  assert.equal(arBooliAnnons({ id: "booli-123", url: null }), false, "ett booli-id utan url ska inte hämtas");
});
