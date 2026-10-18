#!/usr/bin/env bash
# En körning av bostadsvakten i containern på home-vm: samma steg som
# bostadsvakt.yml gör på GitHub. Startas av drift/home-vm.sh, aldrig direkt.
#
# data-repo/ är en bindmount från home-vm (/opt/bostadsvakt/data-repo), så
# klonen av bostadsvakt-data finns kvar mellan körningarna och bara behöver
# hämta det senaste.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

: "${DATA_REPO_TOKEN:?DATA_REPO_TOKEN saknas i /opt/bostadsvakt/.env}"
DATA_URL="${DATA_REPO_URL:-https://github.com/matthewholm/bostadsvakt-data.git}"
# Token via miljön, på samma sätt som actions/checkout gör, så att den aldrig
# skrivs till data-repo/.git/config på disken.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$DATA_REPO_TOKEN" | base64 -w0)"

# Larmet går en gång när körningarna börjar misslyckas och en gång när de
# fungerar igen, inte var 30:e minut så länge felet står kvar. Markören ligger
# i .git/ så att reset och clean inte tar bort den.
MARKOR=data-repo/.git/bostadsvakt-fel
larma() {
  [ -n "${HA_WEBHOOK_URL:-}" ] || return 0
  curl -s -m 20 -X POST "$HA_WEBHOOK_URL" -H "Content-Type: application/json" \
    -d "{\"title\":\"$1\",\"message\":\"$2\"}" > /dev/null || true
}

# set -e gäller inte inne i en funktion som anropas i ett if, därför
# avbryter varje steg själv med return 1.
kor() {
  if [ -d data-repo/.git ]; then
    git -C data-repo fetch -q origin main || return 1
    git -C data-repo reset -q --hard origin/main || return 1
    git -C data-repo clean -q -fd || return 1
  else
    git clone -q "$DATA_URL" data-repo || return 1
  fi
  node src/index.js || return 1
  (cd data-repo && bash ../drift/spara.sh) || return 1
}

if kor; then
  if [ -f "$MARKOR" ]; then
    rm -f "$MARKOR"
    larma "Bostadsvakt: home-vm kör igen" "Körningarna på home-vm fungerar igen."
  fi
else
  if [ -d data-repo/.git ] && [ ! -f "$MARKOR" ]; then
    touch "$MARKOR"
    larma "Bostadsvakt: körningen misslyckades" "En körning på home-vm gick fel. Se journalctl -u bostadsvakt på home-vm. GitHub tar över schemat tills home-vm kör igen."
  fi
  exit 1
fi
