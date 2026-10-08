// Vilken kollektivtrafikmyndighet – och därmed vilket biljettsystem – som
// gäller för en adress avgörs av LÄNET, inte av vilka trafikbolag som råkar
// dyka upp i ett enskilt reseförslag från ResRobot.
//
// Det här är kärnan i buggen som gav "⚠ Flera trafikbolag (UL + SJ) – kan
// kräva separata biljetter" för hus i Norrtälje. Norrtälje kommun ligger i
// STOCKHOLMS län och trafikeras av SL; därifrån behövs aldrig en UL-biljett
// för att komma hemifrån. Varningen hade två orsaker, båda åtgärdade:
//   1. Husen geokodades fel och hamnade i Uppsala län (se geocode.js), så
//      ResRobot planerade resan från fel plats och svarade följdriktigt "UL".
//   2. Koden tolkade varje extra operatörsnamn i en resa som "separata
//      biljetter". Det stämmer inte – byter man SL-buss till pendeltåg står
//      det två operatörer i svaret, men det är fortfarande EN SL-biljett.
// Det som faktiskt kostar en extra biljett är att korsa en länsgräns.

export const SL = {
  kod: "SL",
  namn: "SL",
  lan: "Stockholms län",
  app: "SL-appen",
  // Norrtäljes ytterområden saknar linjelagd trafik. Där kör SL "Närtrafik",
  // som måste bokas i förväg – exakt det användaren såg i sin skärmdump.
  nartrafik: {
    namn: "SL Närtrafik",
    bokning: "bokas senast 2 timmar innan på 08-600 10 00",
  },
};

export const UL = {
  kod: "UL",
  namn: "UL",
  lan: "Uppsala län",
  app: "UL-appen",
  nartrafik: {
    namn: "UL Flexlinjen/anropsstyrd trafik",
    bokning: "bokas i förväg på 0771-14 14 14",
  },
};

// De två län bevakningen gäller. Allt utanför dessa är i praktiken ett tecken
// på felgeokodning snarare än ett hus man faktiskt vill ha – se geocode.js.
export const KOMMUNER = {
  // Stockholms län (26 kommuner) → SL
  botkyrka: SL, danderyd: SL, ekero: SL, haninge: SL, huddinge: SL,
  jarfalla: SL, lidingo: SL, nacka: SL, norrtalje: SL, nykvarn: SL,
  nynashamn: SL, salem: SL, sigtuna: SL, sollentuna: SL, solna: SL,
  stockholm: SL, sundbyberg: SL, sodertalje: SL, tyreso: SL, taby: SL,
  "upplands vasby": SL, "upplands-bro": SL, vallentuna: SL, vaxholm: SL,
  varmdo: SL, osteraker: SL,

  // Uppsala län (8 kommuner) → UL
  enkoping: UL, heby: UL, habo: UL, knivsta: UL, tierp: UL,
  uppsala: UL, alvkarleby: UL, osthammar: UL,
};

// Orter/socknar → kommun. Fyller två syften:
//   1. Bygga en PRECIS geokodningsfråga: vet vi att "Singö" ligger i Norrtälje
//      kan vi fråga Nominatim med rätt kommun och län istället för att chansa.
//   2. Verifiera svaret när Nominatim returnerar en ort men inte kommunen.
// Listan täcker orterna som faktiskt förekommer i flödet (Roslagen + Uppsala-
// bygden). Saknas en ort faller koden tillbaka på kommun/län-fälten i svaret –
// den här listan är en genväg, inte ett krav.
export const ORTER = {
  // Norrtälje kommun (Roslagen) – SL-område, ofta felplacerat i Uppsala förut
  vaddo: "norrtalje", singo: "norrtalje", almsta: "norrtalje",
  hallstavik: "norrtalje", havero: "norrtalje", skebobruk: "norrtalje",
  rimbo: "norrtalje", riala: "norrtalje", ranas: "norrtalje",
  gottrora: "norrtalje", syninge: "norrtalje", grovstanas: "norrtalje",
  bergshamra: "norrtalje", norrtalje: "norrtalje", edsbro: "norrtalje",
  hallstavik_bruk: "norrtalje", rado: "norrtalje", frotuna: "norrtalje",
  loharad: "norrtalje", malsta: "norrtalje", roslagsbro: "norrtalje",
  simpnas: "norrtalje", grisslehamn: "norrtalje", herrang: "norrtalje",
  spillersboda: "norrtalje", furusund: "norrtalje", koping: "norrtalje",
  vato: "norrtalje", blido: "norrtalje", yxlan: "norrtalje",

  // Uppsala kommun
  vange: "uppsala", jumkil: "uppsala", ramstalund: "uppsala",
  storvreta: "uppsala", balinge: "uppsala", vattholma: "uppsala",
  almunge: "uppsala", knutby: "uppsala", rasbokil: "uppsala",
  savja: "uppsala", rocksta: "uppsala", uppsala: "uppsala",
  bjorklinge: "uppsala", lovstalot: "uppsala", gunsta: "uppsala",
  langhundra: "uppsala", funbo: "uppsala", danmark: "uppsala",
  vaksala: "uppsala", gamla_uppsala: "uppsala", skolsta: "uppsala",

  // Övriga Uppsala län
  knivsta: "knivsta", alsike: "knivsta",
  osthammar: "osthammar", oregrund: "osthammar", gimo: "osthammar",
  alunda: "osthammar", osterbybruk: "osthammar", hargshamn: "osthammar",
  tierp: "tierp", skarplinge: "tierp", karlholmsbruk: "tierp",
  orbyhus: "tierp", tobo: "tierp",
  enkoping: "enkoping", orsundsbro: "enkoping", grillby: "enkoping",
  habo: "habo", balsta: "habo",
  heby: "heby", morgongava: "heby", tarnsjo: "heby", harbo: "heby",
  alvkarleby: "alvkarleby", skutskar: "alvkarleby",

  // Vallentuna/Österåker – gränsar mot Norrtälje, också SL
  vallentuna: "vallentuna", kargarde: "vallentuna",
  akersberga: "osteraker", osteraker: "osteraker",

  // Haninge/Tyresö – södra bevakningen (Västerhaninge, Vendelsö, Trollbäcken)
  vasterhaninge: "haninge", vendelso: "haninge", handen: "haninge",
  jordbro: "haninge", brandbergen: "haninge", tungelsta: "haninge",
  dalaro: "haninge", musko: "haninge", orno: "haninge", galo: "haninge",
  krigslida: "haninge", vega: "haninge", haninge: "haninge",
  osterhaninge: "haninge", "arsta havsbad": "haninge", gudo: "haninge",
  trollbacken: "tyreso", "tyreso strand": "tyreso", bollmora: "tyreso",
  oringe: "tyreso", brevik: "tyreso", raksta: "tyreso", tyreso: "tyreso",
};

// Slår ihop å/ä/ö och skiljetecken så "Norrtälje", "NORRTALJE" och
// "Norrtälje kommun" alla landar på samma nyckel.
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\bkommun\b|\bmunicipality\b|\bsocken\b/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Kommun → myndighet. Returnerar null för allt utanför de två länen, vilket
// anroparen använder som "det här ser ut som en felgeokodning".
export function myndighetForKommun(kommun) {
  const n = norm(kommun);
  if (!n) return null;
  if (KOMMUNER[n]) return KOMMUNER[n];
  // Hemnet skriver genitiv: "Stockholms kommun", "Upplands Väsbys kommun".
  if (n.endsWith("s") && KOMMUNER[n.slice(0, -1)]) return KOMMUNER[n.slice(0, -1)];
  // "Norrtälje Municipality"/"Norrtälje kommun" har redan städats av norm(),
  // men Nominatim kan också svara med sammansatta namn – ta första ordet.
  const forsta = n.split(" ")[0];
  return KOMMUNER[forsta] ?? null;
}

// Ort → kommun (via ORTER-listan). Används för att bygga precisa frågor.
export function kommunForOrt(ort) {
  const n = norm(ort);
  if (!n) return null;
  if (ORTER[n]) return ORTER[n];
  if (KOMMUNER[n]) return n; // orten ÄR en kommun, t.ex. "Norrtälje"
  if (n.endsWith("s") && KOMMUNER[n.slice(0, -1)]) return n.slice(0, -1); // "Stockholms"
  const forsta = n.split(" ")[0];
  return ORTER[forsta] ?? (KOMMUNER[forsta] ? forsta : null);
}

// Myndighet direkt från en ort, när vi känner den.
export function myndighetForOrt(ort) {
  const kommun = kommunForOrt(ort);
  return kommun ? myndighetForKommun(kommun) : null;
}

// Snyggt kommunnamn tillbaka ur den normaliserade nyckeln, för texter i
// panelen/notisen ("Norrtälje" snarare än "norrtalje").
const VISNING = {
  norrtalje: "Norrtälje", uppsala: "Uppsala", knivsta: "Knivsta",
  osthammar: "Östhammar", tierp: "Tierp", enkoping: "Enköping",
  habo: "Håbo", heby: "Heby", alvkarleby: "Älvkarleby",
  vallentuna: "Vallentuna", osteraker: "Österåker", sigtuna: "Sigtuna",
  vaxholm: "Vaxholm", varmdo: "Värmdö", stockholm: "Stockholm",
  haninge: "Haninge", tyreso: "Tyresö",
};
export function visaKommun(kommun) {
  const n = norm(kommun);
  return VISNING[n] ?? (n ? n.charAt(0).toUpperCase() + n.slice(1) : "");
}

// Kräver resan två biljetter? Bara när den korsar länsgränsen – inte för att
// flera operatörsnamn nämns. Uppsala↔Stockholm är det klassiska fallet.
export function biljettrad(franMyndighet, tillMyndighet) {
  if (!franMyndighet || !tillMyndighet) return null;
  if (franMyndighet.kod === tillMyndighet.kod) {
    return {
      tvaBiljetter: false,
      text: `En ${franMyndighet.namn}-biljett räcker hela vägen (${franMyndighet.app}).`,
    };
  }
  return {
    tvaBiljetter: true,
    text:
      `Resan korsar länsgränsen ${franMyndighet.lan} → ${tillMyndighet.lan}: ` +
      `det krävs antingen två biljetter (${franMyndighet.namn} + ${tillMyndighet.namn}) ` +
      `eller en kombinationsbiljett (UL:s Uppsala–Stockholm eller Movingo).`,
  };
}
