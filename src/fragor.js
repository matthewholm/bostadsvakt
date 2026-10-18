// Frågor till mäklaren för just det här huset, byggda ur det som är känt och
// det som saknas. En fråga försvinner när svaret finns i husuppgifter.json
// (se objektsida.js), så listan krymper till det som faktiskt återstår att
// ta reda på. Ordningen följer ett samtal: pengarna först (det som ändrar
// kostnadsbilden i kostnader.js), sedan skicket, läget och sist affären.
//
// Reglerna är medvetet vanliga och kontrollerbara, inte AI: en fråga om
// blåbetong ska komma för att byggåret ligger mellan 1929 och 1975, inte för
// att en modell råkade tänka på det den här gången.
//
// Varje fråga hålls under 120 tecken, för längre rader ritar Alva som fritext.

const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
const norm = (s) => (s ?? "").toLowerCase();

/** Avstånd till vatten ur omgivningsraden "Vatten: ca 120 m · Skog: ...",
 *  eftersom själva måttet inte sparas på huset. */
export function vattenAvstand(hus) {
  const rad = (hus.omgivning ?? []).find((r) => r.startsWith("Vatten:"));
  const m = rad?.match(/^Vatten:\s*ca\s*([\d\s]+)\s*m\b/);
  return m ? Number(m[1].replace(/\s/g, "")) : null;
}

export function fragorTillMaklaren(hus, uppgifter = {}, kostnad = null) {
  const u = uppgifter;
  const byggar = u.byggar ?? hus.byggar ?? null;
  const fragor = [];
  const fraga = (villkor, text) => { if (villkor) fragor.push(text); };

  // Pengarna
  const pantbrevSparMax = kostnad && !kostnad.pantbrev.kand ? kostnad.pantbrev.kostnad.total : null;
  fraga(u.pantbrev == null,
    pantbrevSparMax
      ? `Hur mycket pantbrev finns uttagna? Varje 100 000 kr sparar er 2 000 kr, upp till ${kr(pantbrevSparMax)} här.`
      : "Hur mycket pantbrev finns uttagna i fastigheten?");
  const avgiftsfri = byggar != null && byggar >= 2012;
  fraga(u.taxeringsvarde == null && !avgiftsfri, "Vad är taxeringsvärdet? Det styr fastighetsavgiften.");
  const kandDrift = u.driftskostnadManad ?? hus.maklarkalkyl?.driftkostnadManad ?? null;
  fraga(kandDrift == null,
    "Vad var driftkostnaden senaste året, och ingår el, uppvärmning, VA, sophämtning och försäkring?");
  fraga(kandDrift != null, `Vad ingår i driftkostnaden på ${kr(kandDrift ?? 0)}/mån, och gäller den ett helt år?`);
  const tomtratt = /tomträtt/.test(norm(u.upplatelseform));
  fraga(!u.upplatelseform, "Är tomten friköpt eller tomträtt? Vid tomträtt tillkommer en årlig avgäld.");
  fraga(tomtratt && u.tomtrattsavgaldAr == null, "Hur stor är tomträttsavgälden, och när omregleras den nästa gång?");
  fraga(u.samfallighetAr == null && !u.ingenSamfallighet,
    "Ingår huset i en samfällighet eller vägförening, och vad är årsavgiften?");

  // Skicket
  fraga(byggar == null, "Vilket år byggdes huset?");
  fraga(true, "När byttes tak, fönster, dränering, el och vattenledningar senast?");
  fraga(true, "Finns en överlåtelsebesiktning och säljarens frågelista att läsa före visningen?");
  fraga(true,
    byggar != null && byggar >= 1929 && byggar <= 1975
      ? "Är radon mätt? Hus byggda 1929 till 1975 kan ha blåbetong."
      : "Är radon mätt i huset, och vilket värde gav mätningen?");
  fraga(byggar == null || (byggar >= 1960 && byggar <= 1985),
    byggar == null
      ? "Vilken grund har huset: platta, krypgrund eller källare?"
      : `Vilken grund har huset? Hus från ${byggar} har ofta en känd riskkonstruktion i grunden.`);
  const varme = norm(u.uppvarmning);
  fraga(!varme, "Hur värms huset upp, och hur gammal är värmeanläggningen?");
  fraga(/berg|jord|sjö|luft|värmepump/.test(varme), "Hur gammal är värmepumpen, och när servades den senast?");
  fraga(/direkt|elpanna|elradiator|^el$/.test(varme), "Vad kostade elen förra vintern? Direktverkande el blir dyrt i kyla.");
  fraga(/olja/.test(varme), "Finns oljetanken kvar? Oljeeldning är dyr och tanken kan behöva tas bort.");
  const va = norm(u.va);
  fraga(!va, "Är huset anslutet till kommunalt vatten och avlopp? Enskilt avlopp kan kräva dyra åtgärder.");
  fraga(/enskil|egen brunn|brunn/.test(va),
    "När godkändes det enskilda avloppet senast, och finns ett färskt vattenprov från brunnen?");
  fraga(!u.energiklass, "Vilken energiklass och årlig energiförbrukning anger energideklarationen?");

  // Läget
  const vatten = vattenAvstand(hus);
  fraga(vatten != null && vatten <= 300, "Ligger tomten inom strandskydd eller i ett område med översvämningsrisk?");
  fraga(true, "Finns bygglov för alla byggnader och tillbyggnader på tomten?");

  // Affären
  fraga(Boolean(hus.prisSankning),
    hus.prisSankning && `Priset sänktes från ${kr(hus.prisSankning.fran)} till ${kr(hus.prisSankning.till)}. Varför?`);
  fraga(true, "Hur många har visat intresse, finns det bud, och var tror du priset landar?");
  fraga(true, "Varför säljer de, och vilket tillträde önskar säljaren?");

  return fragor.map((f, i) => `${i + 1}. ${f}`);
}

/** Det som redan är känt om huset ur husuppgifter.json, en uppgift per rad. */
export function kandaUppgifter(u = {}) {
  return [
    u.pris != null && `Pris i annonsen: ${kr(u.pris)}`,
    u.pantbrev != null &&
      `Pantbrev: ${u.pantbrevAntal ? `${u.pantbrevAntal} st, totalt ` : ""}${kr(u.pantbrev)}`,
    u.taxeringsvarde != null && `Taxeringsvärde: ${kr(u.taxeringsvarde)}`,
    u.driftskostnadManad != null && `Driftkostnad: ${kr(u.driftskostnadManad)}/mån`,
    u.byggar != null && `Byggår: ${u.byggar}`,
    u.upplatelseform && `Upplåtelseform: ${u.upplatelseform}`,
    u.tomtrattsavgaldAr != null && `Tomträttsavgäld: ${kr(u.tomtrattsavgaldAr)}/år`,
    u.samfallighetAr != null && `Samfällighet och vägförening: ${kr(u.samfallighetAr)}/år`,
    u.ingenSamfallighet && "Ingen samfällighet",
    u.uppvarmning && `Uppvärmning: ${u.uppvarmning}`,
    u.va && `Vatten och avlopp: ${u.va}`,
    u.energiklass && `Energiklass: ${u.energiklass}`,
    u.fastighetsbeteckning && `Fastighetsbeteckning: ${u.fastighetsbeteckning}`,
  ].filter(Boolean);
}
