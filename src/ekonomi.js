// Totalkostnad och "har vi råd", redovisat post för post – samma princip som
// score.js: en slutsats utan sin uträkning går inte att lita på och går inte
// att ifrågasätta när den är fel.
//
// Siffrorna här är två helt olika sorters saker, och det är viktigt att
// hålla isär dem i koden såväl som i huvudet:
//
//   LAGSTADGADE, hämtade 2026-08-21: lagfart, pantbrev, amorteringskrav.
//   Amorteringskravet ändrades 2026-04-01 – skärpt amortering (skuldkvot
//   >4,5x bruttoinkomst gav +1 %) togs bort, bolånetaket höjdes till 90 %
//   belåningsgrad. En källa skriven innan dess datum har fel siffra.
//   Källor: lantmäteriet.se (lagfart/pantbrev), fi.se (amorteringskrav).
//
//   ANTAGANDEN, satta av hushållet: ränta, kalkylränta, driftskostnad-
//   schablon. Inget regelverk sätter dessa – bankerna har egna, opublicerade
//   modeller. Default-värdena nedan är rimliga utgångspunkter (se README),
//   inte fakta, och ska kunna bytas ut i config.json under "hushall.antagande"
//   utan att koden ändras.
//
// Allt är opt-in: utan hushall.nettoinkomstManad och hushall.kontantinsats
// räknas ingenting ut, och notisen får ingen EKONOMI-sektion. Ett hushåll som
// inte fyllt i sin ekonomi ska inte mötas av en genomskiven "0 kr kvar".

const nummer = (n) => Math.round(n).toLocaleString("sv-SE");

export const LAGFART = { procent: 1.5, expedition: 825 };
export const PANTBREV = { procent: 2, expedition: 375 };

/** Normalvilla-schablon, 350–450 kr/m²/år enligt jämförda mäklarkällor. Det
 * verkliga spannet är brett (30 000–80 000 kr/år totalt) – används bara när
 * annonsen inte anger en riktig driftskostnad. */
const DRIFTSKOSTNAD_KVM_AR_DEFAULT = 400;
const RANTA_DEFAULT = 3.2; // ungefärlig snittränta rörlig/kort bindning, aug 2026
const KALKYLRANTA_DEFAULT = 6; // stresstest – ingen bank tvingas till en viss siffra, detta är en försiktig egen

export function beraknaLagfart(kopeskilling) {
  if (!kopeskilling) return null;
  const stampelskatt = Math.round(kopeskilling * (LAGFART.procent / 100));
  return { stampelskatt, expedition: LAGFART.expedition, total: stampelskatt + LAGFART.expedition };
}

/** Antar att HELA lånebeloppet behöver nytt pantbrev – det är det säkra
 * antagandet. Ett hus kan ha befintliga pantbrev som följer med köpet och
 * sänker den riktiga kostnaden, men det är information ingen annonstext ger,
 * och att gissa en lägre kostnad är precis den sortens optimistiska gissning
 * som redan gett fel svar på andra håll i den här appen (jämför "avgift
 * okänd" i bil.js). Hellre en försiktig siffra som går att slå, än en
 * snäll som inte håller. */
export function beraknaPantbrev(pantbrevsbelopp) {
  if (!pantbrevsbelopp || pantbrevsbelopp <= 0) return { stampelskatt: 0, expedition: 0, total: 0 };
  const stampelskatt = Math.round(pantbrevsbelopp * (PANTBREV.procent / 100));
  return { stampelskatt, expedition: PANTBREV.expedition, total: stampelskatt + PANTBREV.expedition };
}

/** Amorteringskravet efter reformen 2026-04-01. Bara belåningsgradstrappan
 * kvar – ingen skärpning längre för hög skuldkvot mot inkomst. */
export function amorteringsprocent(belaningsgrad) {
  if (belaningsgrad == null) return null;
  if (belaningsgrad > 0.7) return 2;
  if (belaningsgrad > 0.5) return 1;
  return 0;
}

/** Känt värde (från annonsen, berikad via Booli) vinner alltid över
 * schablonen – en riktig siffra slår en gissning, hur väl underbyggd
 * gissningen än är. */
export function driftskostnadManad({ kandKrManad, boarea, schablonKvmAr = DRIFTSKOSTNAD_KVM_AR_DEFAULT }) {
  if (kandKrManad != null) return { kr: kandKrManad, kalla: "annons" };
  if (!boarea) return null;
  return { kr: Math.round((boarea * schablonKvmAr) / 12), kalla: "schablon" };
}

/**
 * Hela kostnadsbilden för ett hus: engångskostnader vid köpet och löpande
 * månadskostnad, både till dagens ränta och till en stresstestad kalkylränta
 * – exakt den skillnad en bank faktiskt testar mot, inte bara vad det kostar
 * idag.
 */
export function totalkostnad({ pris, kontantinsats, boarea, driftskostnadKandKrManad, hushall }) {
  if (!pris) return null;
  const antagande = hushall?.antagande ?? {};
  const ranta = antagande.ranta ?? RANTA_DEFAULT;
  const kalkylranta = antagande.kalkylranta ?? KALKYLRANTA_DEFAULT;
  const schablonKvmAr = antagande.driftskostnadKvmAr ?? DRIFTSKOSTNAD_KVM_AR_DEFAULT;

  const kontant = Math.max(0, Math.min(kontantinsats ?? 0, pris));
  const lan = pris - kontant;
  const belaningsgrad = lan / pris;
  const amProcent = amorteringsprocent(belaningsgrad);

  const lagfart = beraknaLagfart(pris);
  const pantbrev = beraknaPantbrev(lan);
  const drift = driftskostnadManad({ kandKrManad: driftskostnadKandKrManad, boarea, schablonKvmAr });
  const driftKr = drift?.kr ?? 0;

  const manadsbelopp = (procentArlig) => Math.round((lan * (procentArlig / 100)) / 12);
  const manadAmortering = manadsbelopp(amProcent);

  return {
    lan,
    kontantinsats: kontant,
    belaningsgradProcent: Math.round(belaningsgrad * 1000) / 10,
    amorteringsprocent: amProcent,
    lagfart,
    pantbrev,
    engangskostnad: (lagfart?.total ?? 0) + pantbrev.total,
    drift,
    manad: {
      ranta: manadsbelopp(ranta),
      amortering: manadAmortering,
      drift: driftKr,
      total: manadsbelopp(ranta) + manadAmortering + driftKr,
    },
    manadStress: {
      ranta: manadsbelopp(kalkylranta),
      amortering: manadAmortering,
      drift: driftKr,
      total: manadsbelopp(kalkylranta) + manadAmortering + driftKr,
    },
    antaganden: { ranta, kalkylranta, driftskostnadKvmAr: schablonKvmAr },
  };
}

// Konsumentverkets hushållskostnader 2026 (mat, kläder/skor, hygien, fritid,
// telefon/media) – INTE boende eller transport, de räknas separat här.
// Barnbeloppen är mat enligt Konsumentverket; övriga kategorier för barn
// saknar källa i samma detalj och hålls därför utanför istället för att
// gissas fram. Källa: konsumentverket.se, hushållskostnader 2026.
const LEVNADSOMKOSTNAD_VUXEN_MANAD = 3600 + 700 + 850 + 700 + 450; // = 6300
const MAT_BARN_MANAD = [
  { maxAlder: 3, kr: 1600 },
  { maxAlder: 6, kr: 2000 },
  { maxAlder: 10, kr: 2400 },
  { maxAlder: 17, kr: 3000 },
];

function matBarn(alder) {
  const rad = MAT_BARN_MANAD.find((r) => alder <= r.maxAlder);
  return rad ? rad.kr : MAT_BARN_MANAD.at(-1).kr;
}

/** Konservativt räknat: bara mat för barnen (källbelagt), ingen gissad andel
 * kläder/fritid/hygien ovanpå – se kommentaren ovan om varför. Det gör
 * levnadsomkostnaden en aning för låg för hushåll med barn, i samma riktning
 * som pantbrevsantagandet är en aning för hög: hellre fel åt det håll som
 * upptäcks (för lite marginal känns snålt) än åt det håll som inte gör det
 * (för mycket marginal känns tryggt och är fel). */
export function levnadsomkostnad({ vuxna = 2, barnAldrar = [] } = {}) {
  const vuxenSumma = vuxna * LEVNADSOMKOSTNAD_VUXEN_MANAD;
  const barnSumma = barnAldrar.reduce((s, alder) => s + matBarn(alder), 0);
  return vuxenSumma + barnSumma;
}

/** Kvar att leva på, i samma anda som en banks KALP – men en egen,
 * förenklad modell, inte en kopia av någon banks (de är interna och olika
 * bank till bank). Räknas alltid mot den stresstestade boendekostnaden,
 * eftersom det är den en bank faktiskt skulle testa mot. */
export function kalp({ nettoinkomstManad, boendekostnadManad, ovrigaLanManad = 0, hushall }) {
  if (nettoinkomstManad == null || boendekostnadManad == null) return null;
  const levnad = levnadsomkostnad(hushall ?? {});
  const kvarAttLevaPa = Math.round(nettoinkomstManad - boendekostnadManad - ovrigaLanManad - levnad);
  return { nettoinkomstManad, boendekostnadManad, ovrigaLanManad, levnadsomkostnad: levnad, kvarAttLevaPa };
}

/**
 * Nettolikvid av att sälja den nuvarande bostaden – vad som faktiskt blir
 * kvar som ny kontantinsats, inte utropspriset.
 */
export function saljaNuvarandeBostad({ varde, kvarstaendeLan = 0, maklarkostnadProcent = 3 }) {
  if (!varde) return null;
  const maklarkostnad = Math.round(varde * (maklarkostnadProcent / 100));
  const nettoLikvid = Math.max(0, Math.round(varde - kvarstaendeLan - maklarkostnad));
  return { varde, kvarstaendeLan, maklarkostnad, nettoLikvid };
}

/**
 * Toppnivå: har hushållet råd med det här huset? Returnerar "okant" (inte
 * ett gissat ja/nej) så länge hushall.nettoinkomstManad eller
 * hushall.kontantinsatsTillgangligt saknas i config.json – exakt samma
 * princip som naturkollen: hellre erkänna att data saknas än låtsas veta.
 */
export function harRad({ pris, boarea, driftskostnadKandKrManad, hushall }) {
  if (hushall?.nettoinkomstManad == null || hushall?.kontantinsatsTillgangligt == null) {
    return { verdikt: "okant", forklaring: 'Hushållsekonomi är inte ifylld i config.json under "hushall".' };
  }
  const kostnad = totalkostnad({
    pris,
    kontantinsats: hushall.kontantinsatsTillgangligt,
    boarea,
    driftskostnadKandKrManad,
    hushall,
  });
  if (!kostnad) return { verdikt: "okant", forklaring: "Huset saknar pris." };

  const marginal = kalp({
    nettoinkomstManad: hushall.nettoinkomstManad,
    boendekostnadManad: kostnad.manadStress.total,
    ovrigaLanManad: hushall.ovrigaLanManad ?? 0,
    hushall,
  });

  const verdikt = marginal.kvarAttLevaPa >= 0 ? "ja" : "nej";
  const forklaring =
    verdikt === "ja"
      ? `${nummer(marginal.kvarAttLevaPa)} kr kvar per månad efter boendekostnad vid stresstestad ränta ` +
        `(${kostnad.antaganden.kalkylranta} %), amortering och levnadsomkostnader.`
      : `${nummer(Math.abs(marginal.kvarAttLevaPa))} kr underskott per månad vid stresstestad ränta ` +
        `(${kostnad.antaganden.kalkylranta} %) – en bank skulle sannolikt neka eller kräva högre kontantinsats.`;

  return { ...kostnad, kalp: marginal, verdikt, forklaring };
}
