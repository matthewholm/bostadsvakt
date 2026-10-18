#!/usr/bin/env bash
# Startas av systemd (bostadsvakt.timer) på home-vm, var 30:e minut kl 06 till
# 21:30. Hämtar senaste koden, bygger om avbilden om något ändrats och kör
# en körning i en container. Se README, "Köra på home-vm".
set -euo pipefail
BAS=/opt/bostadsvakt

# Ny kod på main gäller från nästa körning. Går GitHub inte att nå körs den
# kod som redan finns.
git -C "$BAS/app" pull -q --ff-only || echo "Kunde inte hämta ny kod, kör den som finns."

# Oförändrad kod tar en sekund att bygga (allt ligger i cachen). Misslyckas
# bygget används förra avbilden om den finns.
if ! docker build -q -t bostadsvakt -f "$BAS/app/drift/Dockerfile" "$BAS/app" > /dev/null; then
  docker image inspect bostadsvakt > /dev/null 2>&1 || { echo "Bygget misslyckades och ingen tidigare avbild finns."; exit 1; }
  echo "Bygget misslyckades, kör förra avbilden."
fi
docker image prune -f --filter label=app=bostadsvakt > /dev/null

# --init och --ipc=host är vad Playwright rekommenderar för Chromium i docker.
exec docker run --rm --name bostadsvakt --init --ipc=host \
  --env-file "$BAS/.env" \
  -e DRIFT_KALLA=home-vm \
  -v "$BAS/data-repo:/app/data-repo" \
  bostadsvakt
