// Matchningspoäng 0–100: hur nära drömläget ligger huset, oavsett om det är
// en formell "Träff" eller inte. Viktat pendling 30 %, natur 40 %,
// avskildhet (grannar) 30 %. Saknade mått viktas bort proportionellt.
function linjarPoang(varde, max) {
  if (varde == null || !max || max <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - varde / max)));
}

export function beraknaPoang(k, { hallplatsAvstand, restidMin, vattenM, skogM, grannar } = {}) {
  const delar = [];

  const hallplatsPoang = linjarPoang(hallplatsAvstand, k.maxAvståndHållplatsM);
  const restidPoang = linjarPoang(restidMin, k.maxRestidStockholmMin);
  const pendlingDelar = [hallplatsPoang, restidPoang].filter((p) => p != null);
  if (pendlingDelar.length) {
    delar.push({ vikt: 30, poang: pendlingDelar.reduce((a, b) => a + b, 0) / pendlingDelar.length });
  }

  const vattenPoang = linjarPoang(vattenM, k.maxAvståndVattenM);
  const skogPoang = linjarPoang(skogM, k.maxAvståndSkogM);
  const naturDelar = [vattenPoang, skogPoang].filter((p) => p != null);
  if (naturDelar.length) {
    const krav = k.kravNatur ?? "något";
    // "något" belönar bästa av vatten/skog (räcker med ett), "båda" kräver båda → snitt
    const naturPoang = krav === "något" ? Math.max(...naturDelar) : naturDelar.reduce((a, b) => a + b, 0) / naturDelar.length;
    delar.push({ vikt: 40, poang: naturPoang });
  }

  const grannarPoang = linjarPoang(grannar, k.maxGrannarInom300m);
  if (grannarPoang != null) delar.push({ vikt: 30, poang: grannarPoang });

  if (!delar.length) return null;
  const totalVikt = delar.reduce((s, d) => s + d.vikt, 0);
  const summa = delar.reduce((s, d) => s + d.vikt * d.poang, 0);
  return Math.round(summa / totalVikt);
}
