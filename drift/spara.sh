#!/usr/bin/env bash
# Sparar körningens sedda annonser, träffar och slutpriser i bostadsvakt-data.
# Körs INNE I data-repo/-checkouten efter node src/index.js, både av
# GitHub-workflowen (bostadsvakt.yml) och av containern på home-vm
# (drift/korning.sh), så att de två aldrig sparar på olika sätt.
#
# Samtidiga körningar krockar inte: körningens filer sparas undan, och varje
# försök börjar från senaste origin/main, slår ihop med merge.js och pushar.
# Avvisas pushen har någon annan hunnit före, och då görs allt om.
#
# DRIFT_KALLA (valfri, sätts av home-vm): då skrivs data/drift.json med
# körningens tidpunkt, så att GitHubs schema ser att home-vm kör och hoppar
# över sin tur (se jobbet vakt i bostadsvakt.yml).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src" && pwd)"
UNDAN="$(mktemp -d)"
trap 'rm -rf "$UNDAN"' EXIT

cp data/traffar.json "$UNDAN/mina-traffar.json"
cp data/seen.json "$UNDAN/mina-seen.json"
cp data/slutpriser.json "$UNDAN/mina-slutpriser.json"
# En importfil (se index.js) läses en gång. Den här körningen har läst den,
# så den tas bort när resultatet sparas.
if [ -f data/import.html ]; then touch "$UNDAN/import-last"; fi
# Nya husuppgifter ur inklistrade objektbeskrivningar läggs ovanpå den
# senaste husuppgifter.json av merge.js. Själva deltafilen ska aldrig
# committas, så den flyttas ut ur checkouten.
if [ -f data/husuppgifter-nya.json ]; then mv data/husuppgifter-nya.json "$UNDAN/nya-husuppgifter.json"; fi

git config user.name "bostadsvakt-bot"
git config user.email "actions@users.noreply.github.com"
for i in 1 2 3 4 5; do
  git fetch -q origin main
  git reset -q --hard origin/main
  node "$SRC/merge.js" "$UNDAN/mina-traffar.json" "$UNDAN/mina-seen.json" "$UNDAN/mina-slutpriser.json" "$UNDAN/nya-husuppgifter.json"
  node "$SRC/sida.js"
  if [ -f "$UNDAN/import-last" ]; then git rm -q --ignore-unmatch data/import.html; fi
  if [ -n "${DRIFT_KALLA:-}" ]; then
    printf '{\n  "kalla": "%s",\n  "senasteKorning": "%s"\n}\n' "$DRIFT_KALLA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > data/drift.json
  fi
  git add data/
  if git diff --cached --quiet; then echo "Inget nytt att spara."; exit 0; fi
  if [ "$(git diff --cached --name-only)" = "data/drift.json" ]; then
    git commit -q -m "Körning på $DRIFT_KALLA, inget nytt"
  else
    git commit -q -m "Uppdatera sedda annonser och träffar"
  fi
  if git push -q origin HEAD:main; then echo "Sparat."; exit 0; fi
  echo "Push avvisad (försök $i), hämtar senaste och slår ihop igen."
  sleep 3
done
echo "Kunde inte spara efter flera försök."
exit 1
