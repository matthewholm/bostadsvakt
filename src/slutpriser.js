// Prisjämförelse: bygger upp en rullande databas över sålda hus (kr/m² per
// område) från Boolis "slutpriser"-bevakning, och jämför nya annonser mot
// den – något ingen bostadssajt gör åt köparen. Kräver att man sätter upp en
// separat Booli-bevakning på slutpriser (samma inkorg); se README.
import { readFileSync, writeFileSync } from "node:fs";
import { laddaDetaljer } from "./mailsource.js";

const FIL = new URL("../data/slutpriser.json", import.meta.url);
const MAX_POSTER = 400;
const MAX_ALDER_DAGAR = 270; // ~9 månader – tillräckligt färskt för att spegla marknaden
const MIN_JAMFORELSER = 3; // för få sålda hus i ett område ger ett opålitligt snitt

export function lasSlutpriser() {
  try {
    return JSON.parse(readFileSync(FIL, "utf8"));
  } catch {
    return [];
  }
}

export function sparaSlutpriser(lista) {
  const grans = Date.now() - MAX_ALDER_DAGAR * 86400000;
  const stadad = lista
    .filter((p) => new Date(p.datum).getTime() >= grans)
    .sort((a, b) => (b.datum ?? "").localeCompare(a.datum ?? ""))
    .slice(0, MAX_POSTER);
  writeFileSync(FIL, JSON.stringify(stadad, null, 2) + "\n");
  return stadad;
}

// Tolkar en "slutpriser"-bevakningsmejl (samma husblock-format som
// nya-annonser-mejlen) till sålda poster med kr/m².
export function tolkaSlutpriserMail(html) {
  const detaljer = laddaDetaljer(html);
  const nu = new Date().toISOString();
  const poster = [];
  for (const [, d] of detaljer) {
    if (!d.pris || !d.boarea) continue;
    poster.push({
      ort: normOrt(d.ort),
      typ: (d.typ || "").toLowerCase(),
      kvmPris: Math.round(d.pris / d.boarea),
      datum: nu,
    });
  }
  return poster;
}

export function normOrt(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
}

// Snittpris/m² för ett område. Provar först samma hustyp, faller sedan
// tillbaka till alla hustyper i området om det inte räcker med jämförelser.
export function beraknaAreaSnitt(ort, typ, poster = lasSlutpriser()) {
  const o = normOrt(ort);
  if (!o) return null;
  const iOmradet = poster.filter((p) => p.ort === o || p.ort.includes(o) || o.includes(p.ort));
  const somTyp = typ ? iOmradet.filter((p) => p.typ === typ.toLowerCase()) : [];
  const urval = somTyp.length >= MIN_JAMFORELSER ? somTyp : iOmradet;
  if (urval.length < MIN_JAMFORELSER) return null;
  const snitt = Math.round(urval.reduce((s, p) => s + p.kvmPris, 0) / urval.length);
  return { snittKvm: snitt, antal: urval.length };
}

// Jämför ett hus (pris+boarea+ort+typ) mot områdessnittet. Returnerar null om
// data saknas eller för få jämförelsepunkter finns.
export function jamforPris({ pris, boarea, ort, typ }, poster = lasSlutpriser()) {
  if (!pris || !boarea || !ort) return null;
  const snitt = beraknaAreaSnitt(ort, typ, poster);
  if (!snitt) return null;
  const husKvm = Math.round(pris / boarea);
  const diffProcent = Math.round(((husKvm - snitt.snittKvm) / snitt.snittKvm) * 100);
  return { husKvm, snittKvm: snitt.snittKvm, diffProcent, antalJamforelser: snitt.antal };
}
