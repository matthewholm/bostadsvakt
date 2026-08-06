# 🏡 Bostadsvakt

Bevakar nya **villor till salu i Uppsala och Norrtälje** och skickar en push-notis till din mobil när det dyker upp ett hus som:

- 🚏 ligger nära en hållplats (SL/UL – buss, pendeltåg, tåg)
- 🌊 ligger nära vatten och/eller 🌲 skog
- 🏘️ inte har för många grannar

Körs gratis i GitHub Actions var 30:e minut – din dator behöver inte vara på.

## Så funkar den

1. **Booli API** – hämtar nya villaannonser för sökområdena i [config.json](config.json).
2. **Trafiklab ResRobot** – hittar närmaste hållplats och närmaste tågstation från husets koordinater.
3. **OpenStreetMap (Overpass)** – uppskattar avstånd till vatten och skog samt räknar byggnader inom 300 m (grannar). Ingen nyckel behövs.
4. **Home Assistant-webhook** – skickar push med adress, pris och alla avstånd, med länk direkt till annonsen.

Redan sedda annonser sparas i `data/seen.json` så att du bara får notis en gång per hus. Allra första körningen skickar inga notiser – den bara "nollställer" mot dagens utbud.

## Datakällor – välj en eller båda

Appen kan hämta annonser på två sätt. Det räcker med en av dem; har du båda får du bäst täckning (dubbletter räknas bara en gång):

### A. Bevakningsmejl från Hemnet/Booli (ingen API-nyckel behövs)

Låt Hemnet och Booli göra sökjobbet – appen läser deras bevakningsmejl i en egen inkorg, geokodar adressen (OpenStreetMap Nominatim) och kör alla dina kriterier innan den bestämmer om du ska notifieras.

1. **Skapa en dedikerad Gmail-adress** (t.ex. `dittnamn.bostadsvakt@gmail.com`). Aktivera tvåstegsverifiering och skapa ett **app-lösenord** ([myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)).
2. **Skapa bevakningar** på [hemnet.se](https://www.hemnet.se) och/eller [booli.se](https://www.booli.se) för dina områden och hustyper, med mejlutskick ("direkt" hellre än dagligen) till den adressen.
3. **Lägg in secrets**: `IMAP_USER` (mejladressen) och `IMAP_PASSWORD` (app-lösenordet). Annan mejlleverantör än Gmail? Sätt även `IMAP_HOST`.

Appen läser bara olästa mejl från Hemnet/Booli och markerar dem som lästa efteråt. Sätt bevakningarna brett (bara område + hustyp) och låt appen sköta finfiltret – då kan du ändra kriterier i panelen utan att röra Hemnet/Booli.

### B. Boolis API

Kräver `BOOLI_CALLER_ID` + `BOOLI_PRIVATE_KEY`. Boolis publika API-sida är nedtagen, men API:t svarar fortfarande – mejla `api@booli.se` och be om en nyckel för privat, icke-kommersiellt bruk.

## Kom igång

### 1. Skaffa nycklar (gratis)

| Tjänst | Hur | Hemlighet(er) |
|---|---|---|
| **Datakälla** | Se avsnittet ovan – mejlbevakning (A) och/eller Booli-API (B). | `IMAP_USER`, `IMAP_PASSWORD` eller `BOOLI_CALLER_ID`, `BOOLI_PRIVATE_KEY` |
| **Trafiklab** | Skapa gratiskonto på [developer.trafiklab.se](https://developer.trafiklab.se), skapa ett projekt och lägg till API:t **ResRobot v2.1**. | `RESROBOT_API_KEY` |
| **Home Assistant** | En webhook-automation i din HA som skickar vidare till mobilappen/apparna (se "Notiser till flera personer" nedan). | `HA_WEBHOOK_URL` |

### 2. Lägg in hemligheterna i GitHub

Gå till repot → **Settings → Secrets and variables → Actions → New repository secret** och lägg in de fyra hemligheterna ovan. Eller via terminalen:

```
gh secret set BOOLI_CALLER_ID
gh secret set BOOLI_PRIVATE_KEY
gh secret set RESROBOT_API_KEY
gh secret set HA_WEBHOOK_URL
```

### 3. Starta

Gå till fliken **Actions** i repot, välj workflowen **Bostadsvakt** och klicka **Run workflow** (första gången). Därefter kör den automatiskt var 30:e minut kl 06–21.

## Anpassa kriterierna

**Allra enklast: kontrollpanelen** — en webbsida med reglage för alla kriterier, knappar för att köra test/bevakning och lista över senaste körningarna. Den hostas i Home Assistant: `https://home.houseofholm.se/local/bostadsvakt.html`. Logga in med en fine-grained GitHub-token (Contents + Actions, read/write, endast detta repo). Koden ligger i [bostadsvakt-panel](https://github.com/matthewholm/bostadsvakt-panel) — uppdatera kopian med `wget` enligt panel-repots README.

**Eller via formuläret.** Gå till **Actions → Ändra inställningar → Run workflow**. Fyll bara i det du vill ändra — tomma fält (och valet "behåll") lämnas som de är. Funkar även i GitHub-appen i mobilen. Resultatet visas i körningens sammanfattning.

Allt sparas i [config.json](config.json), som du förstås också kan redigera direkt:

```jsonc
{
  "searches": [ { "namn": "Uppsala", "q": "Uppsala" } ],   // lägg till fler områden
  "kriterier": {
    "objectType": "villa",
    "maxPris": null,                  // t.ex. 5000000
    "maxAvståndHållplatsM": 1000,     // max meter till närmaste hållplats
    "maxAvståndVattenM": 1500,
    "maxAvståndSkogM": 500,
    "kravVattenEllerSkog": true,      // minst ett av vatten/skog måste uppfyllas
    "maxGrannarInom300m": 15,
    "andraMal": { "namn": "Kontoret", "adress": "Sveavägen 1, Stockholm" } // valfritt, bara informativt – inget hårt filter
  },
  "notiser": { "endastTräffar": true } // false = notis om ALLA nya, träffar märks med 🎯
}
```

## Testa direkt på GitHub

Gå till fliken **Actions** → välj **Testa Bostadsvakt** i vänsterspalten → klicka **Run workflow**. Testet kör hela kedjan med ett låtsashus utanför Norrtälje och funkar även innan alla nycklar är på plats:

- Utan några secrets alls: loggen visar natur-kollen och notisen som text.
- Med `HA_WEBHOOK_URL` satt: du får en riktig push i mobilen inom någon minut. 📱
- Med `RESROBOT_API_KEY` satt: hållplatskollen testas också.

Klicka på körningen i listan för att se loggen steg för steg.

## Köra lokalt (för test)

Skapa en fil `.env` i projektmappen:

```
BOOLI_CALLER_ID=...
BOOLI_PRIVATE_KEY=...
RESROBOT_API_KEY=...
HA_WEBHOOK_URL=...
```

Kör sedan:

```
npm start
```

Utan `HA_WEBHOOK_URL` skrivs notiserna bara ut i terminalen (torrkörning).

## Bra att veta

- Avstånden till vatten/skog mäts mot objektens mittpunkt i OpenStreetMap och är **ungefärliga** (men allt som rapporteras ligger inom 1,5 km).
- "Grannar" = antal byggnader inom 300 m enligt OpenStreetMap – uthus och garage räknas också, så jämför siffror mellan hus snarare än att tolka dem exakt.
- GitHub Actions cron är inte exakt på minuten – körningarna kan komma några minuter senare.
