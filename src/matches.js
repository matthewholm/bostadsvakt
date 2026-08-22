// Håller en lista över hus appen notifierat om (data/traffar.json), så att
// kontrollpanelen kan visa dem som ett galleri. Nyast först, max 100 sparas.
import { readFileSync, writeFileSync } from "node:fs";

const FIL = new URL("../data/traffar.json", import.meta.url);

export function lasTraffar() {
  try {
    return JSON.parse(readFileSync(FIL, "utf8"));
  } catch {
    return [];
  }
}

export function sparaTraffar(lista) {
  const rensad = lista
    .filter((t) => !t.dold)
    .sort((a, b) => (b.tidpunkt ?? "").localeCompare(a.tidpunkt ?? ""))
    .slice(0, 100);
  writeFileSync(FIL, JSON.stringify(rensad, null, 2) + "\n");
}
