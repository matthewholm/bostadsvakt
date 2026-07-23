// Håller reda på vilka annonser som redan setts (data/seen.json).
import { readFileSync, writeFileSync } from "node:fs";

const FIL = new URL("../data/seen.json", import.meta.url);

export function lasSedda() {
  try {
    return new Set(JSON.parse(readFileSync(FIL, "utf8")));
  } catch {
    return new Set();
  }
}

export function sparaSedda(set) {
  writeFileSync(FIL, JSON.stringify([...set].sort(), null, 2) + "\n");
}
