// Daglig hälsokoll: en kort sammanfattning så man vet att bevakningen
// faktiskt är igång. Uteblir den här notisen en dag är det ett tydligt
// tecken på att något gått sönder (t.ex. utgången token eller stoppad Action).
//
// Läser flödet från Alva numera, inte en lokal fil – samma skäl som
// index.js. Sparade favoriter räknas inte längre här: de bor i Alvas egna
// listor bakom en session, som den här nyckeln (avsiktligt) inte öppnar.
import { notis } from "./notify.js";
import { harAlva, hamtaTillstand } from "./alva.js";

if (!harAlva()) {
  console.error("ALVA_URL och ALVA_INGEST_TOKEN är inte satta. Se README.md.");
  process.exit(1);
}
const { hus } = await hamtaTillstand();
const antalTraffar = hus.filter((t) => t.uppfyller).length;

await notis({
  titel: "Bostadsvakt: allt igång",
  meddelande: [
    `${hus.length} hus i flödet just nu, varav ${antalTraffar} träffar.`,
    "Bevakningen körde utan fel senaste dygnet.",
  ].join("\n"),
  prioritet: 2,
});
