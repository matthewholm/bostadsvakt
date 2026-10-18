// Husets sorteringsvärden för sida.json: de tal en läsare vill ordna flödet
// efter, som generiska { label, value }-par. Etiketten är det enda sidan
// visar, så den säger vad talet är och inget mer; sidan vet inte att det
// handlar om hus.
//
// Värdena är husets riktiga tal, inte vända för att passa en viss sidas
// standardriktning. Alva sorterar fallande när man väljer ett värde, alltså
// högst först, och pilen bredvid vänder till lägst först. Då blir:
//   Matchning              högst först = bäst först
//   Ålder (byggår)         högst först = nyast först
//   Pris                   högst först = dyrast först, vänd för billigast
//   Månadskostnad          högst först = dyrast först, vänd för billigast
//   Restid till <mål>      högst först = längst först, vänd för kortast
//   Pris mot uppskattning  högst först = mest över uppskattningen, vänd för
//                          de hus som är billigast satta mot sitt värde
// Ett negerat tal hade gett "bäst först" utan att vända pilen, men då säger
// pilens egen text ("lägst först") emot det man ser, och talet är fel för
// varje annan läsare av filen.
//
// Ett värde som saknas utelämnas hellre än att sättas till 0: Alva lägger
// hus utan värdet sist, medan 0 hade sett ut som billigast eller närmast.

/**
 * hus: posten (med pris ur husuppgifter om det saknades). byggar: husets
 * byggår, uppgifterna före annonsen. kostnad: kostnadsbild(), eller null.
 * pris: prisbedomning(), eller null. mal: pendlingsmålet i config.
 */
export function sorteringsvarden({ hus, byggar = hus.byggar, kostnad = null, pris = null, mal = null }) {
  // Restiden gäller det mål huset mättes mot. Ett hus mätt mot ett tidigare
  // mål hör inte hemma i samma ordning som de andra förrän det mätts om.
  const restidGaller = hus.restidMin != null && mal?.namn && (hus.pendlingsmal ?? mal.namn) === mal.namn;
  return [
    hus.poang != null && { label: "Matchning", value: hus.poang },
    hus.pris != null && { label: "Pris", value: hus.pris },
    byggar != null && { label: "Ålder", value: byggar },
    kostnad?.manad?.total != null && { label: "Månadskostnad", value: kostnad.manad.total },
    restidGaller && { label: `Restid till ${mal.namn}`, value: hus.restidMin },
    // Samma avrundning som raden i PRISBEDÖMNING, så att ordningen och
    // texten i kortet säger samma sak.
    pris?.varde && hus.pris && { label: "Pris mot uppskattning", value: Math.round(((hus.pris - pris.varde) / pris.varde) * 100) },
  ].filter((v) => v && Number.isFinite(v.value));
}
