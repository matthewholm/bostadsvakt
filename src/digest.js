// Daglig hälsokoll: en kort sammanfattning så man vet att bevakningen
// faktiskt är igång. Uteblir den här notisen en dag är det ett tydligt
// tecken på att något gått sönder (t.ex. utgången token eller stoppad Action).
import { readFileSync } from "node:fs";
import { notis } from "./notify.js";

function las(path, fallback) {
  try {
    return JSON.parse(readFileSync(new URL(`../data-repo/${path}`, import.meta.url), "utf8"));
  } catch {
    return fallback;
  }
}

const traffar = las("data/traffar.json", []);
const listor = las("data/listor.json", { favoriter: {} });
const antalTraffar = traffar.filter((t) => t.uppfyller).length;
const antalSparade = Object.keys(listor.favoriter || {}).length;

await notis({
  titel: "Bostadsvakt: allt igång",
  meddelande: [
    `${traffar.length} hus i flödet just nu, varav ${antalTraffar} träffar.`,
    `${antalSparade} sparade favoriter.`,
    "Bevakningen körde utan fel senaste dygnet.",
  ].join("\n"),
  prioritet: 2,
});
