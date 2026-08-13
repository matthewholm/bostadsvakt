// Matchningspoäng 0–100 MED redovisning: hur nära drömläget ligger huset,
// och framför allt VARFÖR.
//
// Tidigare returnerade den här filen bara en siffra. Det gjorde poängen
// omöjlig att lita på – "varför är det här huset 80 och det där 20?" gick
// helt enkelt inte att svara på, och en felaktig siffra (t.ex. för att huset
// geokodats fel) såg exakt lika trovärdig ut som en riktig. Nu returneras
// hela uträkningen: varje faktors mätvärde, vad den jämförs mot, delpoängen
// den ger, hur tungt den väger och hur många poäng den faktiskt bidrog med.
//
// Vikterna (natur 40 %, pendling 30 %, avskildhet 30 %) är oförändrade mot
// förut. Nyheten inom pendling är turtäthet: förut kunde ett hus få full
// pendlingspoäng för att hållplatsen låg 200 m bort, även om det bara gick
// två bussar om dagen dit – eller ingen alls utan förbeställning.

// Linjär skala: 0 (eller bättre) = 100 poäng, vid gränsvärdet = 0 poäng.
function linjar(varde, max) {
  if (varde == null || !max || max <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - varde / max)));
}

const rund = (n) => Math.round(n * 10) / 10;
const nummer = (n) => Number(n).toLocaleString("sv-SE");

export function beraknaMatchning(k, matt = {}) {
  const { hallplatsAvstand, restidMin, turtathetAvgangar, vattenM, skogM, grannar } = matt;

  // ---- Pendling (30 %) ----
  const pendlingsDelar = [
    {
      nyckel: "hallplats",
      namn: "Avstånd till hållplats",
      vikt: 10,
      varde: hallplatsAvstand,
      enhet: "m",
      krav: k.maxAvståndHållplatsM,
      delpoang: linjar(hallplatsAvstand, k.maxAvståndHållplatsM),
      text: hallplatsAvstand != null
        ? `${nummer(hallplatsAvstand)} m till närmaste hållplats (kravet är max ${nummer(k.maxAvståndHållplatsM)} m)`
        : null,
    },
    {
      nyckel: "restid",
      namn: "Restid till Stockholm C",
      vikt: 12,
      varde: restidMin,
      enhet: "min",
      krav: k.maxRestidStockholmMin,
      delpoang: linjar(restidMin, k.maxRestidStockholmMin),
      text: restidMin != null
        ? `${nummer(restidMin)} min till Stockholm C (kravet är max ${nummer(k.maxRestidStockholmMin)} min)`
        : null,
    },
    {
      nyckel: "turtathet",
      namn: "Turtäthet",
      vikt: 8,
      varde: turtathetAvgangar,
      enhet: "avgångar/vardag",
      krav: 40,
      // 40 avgångar/vardag ≈ var 20:e minut = full poäng. Noll avgångar ger
      // noll – ett hus där bussen måste förbeställas ska inte kunna få samma
      // pendlingspoäng som ett hus med kvartstrafik.
      delpoang: turtathetAvgangar == null ? null : Math.max(0, Math.min(100, (turtathetAvgangar / 40) * 100)),
      text: turtathetAvgangar != null
        ? `${nummer(turtathetAvgangar)} avgångar en vanlig vardag (40 = full poäng)`
        : null,
    },
  ];

  // ---- Natur (40 %) ----
  const kravNatur = k.kravNatur ?? "något";
  const vattenPoang = linjar(vattenM, k.maxAvståndVattenM);
  const skogPoang = linjar(skogM, k.maxAvståndSkogM);
  const naturMatt = [
    { namn: "Avstånd till vatten", varde: vattenM, krav: k.maxAvståndVattenM, delpoang: vattenPoang },
    { namn: "Avstånd till skog", varde: skogM, krav: k.maxAvståndSkogM, delpoang: skogPoang },
  ].filter((d) => d.delpoang != null);

  const naturDelar = [];
  if (naturMatt.length) {
    // "något" = det räcker med vatten ELLER skog → bästa värdet gäller.
    // "båda" = båda krävs → snittet gäller.
    const delpoang = kravNatur === "något"
      ? Math.max(...naturMatt.map((d) => d.delpoang))
      : naturMatt.reduce((s, d) => s + d.delpoang, 0) / naturMatt.length;
    const bast = naturMatt.reduce((a, b) => (b.delpoang > a.delpoang ? b : a));
    naturDelar.push({
      nyckel: "natur",
      namn: "Natur",
      vikt: 40,
      varde: null,
      enhet: "",
      krav: null,
      delpoang,
      text:
        naturMatt.map((d) => `${d.namn.replace("Avstånd till ", "")} ${nummer(d.varde)} m (max ${nummer(d.krav)} m)`).join(", ") +
        (kravNatur === "något"
          ? ` – kravet är "något", så bästa värdet räknas (${bast.namn.replace("Avstånd till ", "")})`
          : ` – kravet är "båda", så snittet räknas`),
    });
  }

  // ---- Avskildhet (30 %) ----
  const grannarDelar = [];
  const grannarPoang = linjar(grannar, k.maxGrannarInom300m);
  if (grannarPoang != null) {
    grannarDelar.push({
      nyckel: "grannar",
      namn: "Avskildhet",
      vikt: 30,
      varde: grannar,
      enhet: "byggnader inom 300 m",
      krav: k.maxGrannarInom300m,
      delpoang: grannarPoang,
      text: `${nummer(grannar)} byggnader inom 300 m (kravet är max ${nummer(k.maxGrannarInom300m)})`,
    });
  }

  const alla = [...pendlingsDelar, ...naturDelar, ...grannarDelar];
  const med = alla.filter((d) => d.delpoang != null);
  const saknas = alla.filter((d) => d.delpoang == null).map((d) => d.namn);

  if (!med.length) {
    return { poang: null, delar: [], saknas, forklaring: "För lite data för att räkna ut en matchning." };
  }

  // Saknade mått viktas bort proportionellt: har vi ingen naturdata blir de
  // 40 procentenheterna inte "noll poäng", de fördelas på det vi faktiskt vet.
  const totalVikt = med.reduce((s, d) => s + d.vikt, 0);
  const delar = med.map((d) => {
    const andel = (d.vikt / totalVikt) * 100;
    return {
      ...d,
      delpoang: Math.round(d.delpoang),
      andelProcent: rund(andel),
      bidrag: rund((d.delpoang * d.vikt) / totalVikt),
      maxBidrag: rund(andel),
    };
  });

  const poang = Math.round(delar.reduce((s, d) => s + (d.delpoang * d.vikt) / totalVikt, 0));
  const sorterade = [...delar].sort((a, b) => b.delpoang - a.delpoang);
  const starkast = sorterade[0];
  const svagast = sorterade[sorterade.length - 1];

  const forklaring = [
    `${poang}/100 är ett viktat snitt av ${delar.length} faktorer: ` +
      delar.map((d) => `${d.namn.toLowerCase()} ${Math.round(d.andelProcent)} %`).join(", ") + ".",
    starkast && starkast !== svagast
      ? `Starkast: ${starkast.namn.toLowerCase()} (${starkast.delpoang}/100, ger ${starkast.bidrag} av max ${starkast.maxBidrag} poäng).`
      : "",
    svagast && starkast !== svagast
      ? `Svagast: ${svagast.namn.toLowerCase()} (${svagast.delpoang}/100, ger bara ${svagast.bidrag} av max ${svagast.maxBidrag} poäng).`
      : "",
    saknas.length ? `Saknar data för: ${saknas.join(", ").toLowerCase()} – de är bortviktade, inte nollade.` : "",
  ].filter(Boolean).join(" ");

  return { poang, delar, saknas, forklaring };
}

// Bakåtkompatibel genväg för kod som bara vill ha siffran.
export function beraknaPoang(k, matt) {
  return beraknaMatchning(k, matt).poang;
}
