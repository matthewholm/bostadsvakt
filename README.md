# 🏡 Bostadsvakt

Bevakar nya **villor till salu i Uppsala och Norrtälje** och skickar en push-notis till din mobil när det dyker upp ett hus som:

- 🚏 ligger nära en hållplats (SL/UL – buss, pendeltåg, tåg)
- 🌊 ligger nära vatten och/eller 🌲 skog
- 🏘️ inte har för många grannar

Körs gratis i GitHub Actions var 30:e minut – din dator behöver inte vara på.

## Så funkar den

1. **Booli API** – hämtar nya villaannonser för sökområdena i `config.json`, som bor i [bostadsvakt-data](https://github.com/matthewholm/bostadsvakt-data) (se [Var data bor](#var-data-bor)).
2. **Geokodning med kommunkontroll** (Nominatim/Photon) – översätter adressen till koordinater och **verifierar att träffen ligger i rätt kommun** innan den accepteras. Utan verifiering kan en gata med samma namn i fel del av landet accepteras blint. Se [src/geocode.js](src/geocode.js).
3. **Trafiklab ResRobot** – närmaste hållplats, närmaste tågstation, restid till Stockholm C och **turtäthet** (hur många avgångar det faktiskt går en vanlig vardag). Täcker hela Sverige, alltså både SL och UL, med samma nyckel.
4. **SL Transport-API** (ingen nyckel) – används där huset ligger i SL-område, för att namnge hållplatser/linjer exakt och upptäcka **anropsstyrd närtrafik som måste bokas i förväg**.
5. **OpenStreetMap (Overpass)** – uppskattar avstånd till vatten och skog samt räknar byggnader inom 300 m (grannar). Ingen nyckel behövs.
6. **Home Assistant-webhook** – skickar push med adress, pris och alla avstånd, med länk direkt till annonsen.

Två fält till hämtas från Booli-annonser, utöver de sex ovan: **driftskostnad och byggår** direkt från annonssidan ([src/annonsberikning.js](src/annonsberikning.js)), och **mäklarens egen boendekalkyl** (driftkostnad, lagfart, amortering enligt mäklaren) från mäklarens länk på Boolis annonssida – bara den bekräftade Vitec-plattformen hittills, en headless webbläsare krävs eftersom mäklarsidorna renderas med JavaScript ([src/maklarkalkyl.js](src/maklarkalkyl.js)). Hämtas en gång per hus, inte varje körning.

### Vilket trafikbolag och hur många biljetter?

Vilket biljettsystem som gäller avgörs av **länet**, inte av vilka bolagsnamn som råkar dyka upp i ett enskilt reseförslag:

| Område | Kommuner | Trafikbolag |
|---|---|---|
| Stockholms län | bl.a. **Norrtälje**, Vallentuna, Österåker, Sigtuna | **SL** |
| Uppsala län | Uppsala, Knivsta, Enköping, Tierp, Östhammar, Håbo, Heby, Älvkarleby | **UL** |

Kartan finns i [src/lan.js](src/lan.js). Två biljetter flaggas **bara** när resan korsar länsgränsen – ett byte mellan SL-buss och pendeltåg är fortfarande en enda SL-biljett.

### Matchningspoängen (0–100)

Poängen är ett viktat snitt där **saknade mått viktas bort proportionellt** i stället för att nollas:

| Faktor | Vikt | Full poäng vid |
|---|---|---|
| Natur (vatten/skog) | 40 % | på plats – `kravNatur` styr om det räcker med *något* eller krävs *båda* |
| Avskildhet (grannar inom 300 m) | 30 % | 0 grannar |
| Restid till Stockholm C | 12 % | 0 min |
| Avstånd till hållplats | 10 % | 0 m |
| Turtäthet | 8 % | 40 avgångar/vardag (≈ var 20:e minut) |

Uträkningen sparas per hus (`matchning` i `data/traffar.json`) med varje faktors mätvärde, delpoäng, vikt och bidrag – det är den panelen visar under "Varför 72/100?". Ett hus där bussen måste förbeställas får noll på turtäthet, även om restiden råkar se bra ut.

### När bussen måste förbeställas

I Roslagens och Uppsalas ytterområden är närmaste "hållplats" ofta bara en punkt
som trafikeras av anropsstyrd trafik – man ringer och beställer timmar i förväg.
Ett sådant hus såg tidigare ut att ha bra pendling ("Hållplats: X · 400 m") fast
det i praktiken inte gick att pendla därifrån.

Men det gör det ofta ändå, med bil till en riktig hållplats. När trafiken vid
dörren kräver förbokning eller har färre än sex avgångar per vardag letar
bevakningen därför upp närmaste hållplats man kan **köra** till och faktiskt
pendla vidare från, och redovisar:

- körtid och vägsträcka dit ([OSRM](https://project-osrm.org), gratis och utan nyckel)
- parkeringen vid hållplatsen, med tonvikt på om den kostar något – `park_ride`
  och `fee` ur OpenStreetMap. Saknas `fee` står det *avgift okänd* i stället för
  att lova gratis
- turtätheten därifrån
- hela restiden dörr till dörr: bil + kollektivt

Matchningen räknas då på den hållplats man faktiskt kliver på, men varje kvart
bakom ratten drar av en tiondel av turtäthetspoängen. Avdraget bottnar vid 40 % –
att köra dit är ett fungerande alternativ, inte samma sak som ingen trafik alls.

### Hur säker är kartnålen?

Varje hus sparar `platsPrecision`: `hus` (husnummerträff), `gata` eller `ort`. En ortsnivåträff kan ligga kilometervis fel, och ritas därför som en streckad, ihålig nål i panelen. Hus utan verifierbar plats får **ingen** nål alls och visar "Plats okänd" – ärligare än en nål på fel ställe, eftersom allt som mäts därifrån (hållplats, natur, grannar, restid) annars också blir fel.

Hus som sparades innan kommunkontrollen fanns rättas automatiskt: varje körning tar upp till 15 av dem, geokodar om och räknar om hela analysen från rätt plats – utan att skicka notis.

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
| **Trafiklab** | Skapa gratiskonto på [developer.trafiklab.se](https://developer.trafiklab.se), skapa ett projekt och lägg till API:t **ResRobot v2.1**. Samma nyckel täcker både SL och UL – ingen separat UL-nyckel behövs. | `RESROBOT_API_KEY` |
| **SL Transport** | Inget att göra – API:t är öppet och kräver ingen nyckel. | – |
| **Home Assistant** | En webhook-automation i din HA som skickar vidare till mobilappen/apparna (se "Notiser till flera personer" nedan). | `HA_WEBHOOK_URL` |
| **bostadsvakt-data** | Kriterier, hushållets ekonomi och husflödet bor i ett separat, privat repo — det här repot är (eller blir) publikt, se avsnittet nedan. Skapa en fine-grained personal access token scopad bara till `bostadsvakt-data`, med Contents: read/write. | `DATA_REPO_TOKEN` |

### 2. Lägg in hemligheterna i GitHub

Gå till repot → **Settings → Secrets and variables → Actions → New repository secret** och lägg in hemligheterna ovan. Eller via terminalen:

```
gh secret set BOOLI_CALLER_ID
gh secret set BOOLI_PRIVATE_KEY
gh secret set RESROBOT_API_KEY
gh secret set HA_WEBHOOK_URL
gh secret set DATA_REPO_TOKEN
```

### 3. Starta

Gå till fliken **Actions** i repot, välj workflowen **Bostadsvakt** och klicka **Run workflow** (första gången). Därefter kör den automatiskt var 30:e minut kl 06–21.

## Var data bor

Kriterier, hushållets ekonomi och husflödet ligger inte i det här repot —
det är (eller blir) publikt, och den datan är personlig. De bor i ett
separat privat repo, [bostadsvakt-data](https://github.com/matthewholm/bostadsvakt-data),
som varje workflow checkar ut vid sidan av sig själv (`data-repo/`, en
fine-grained token scopad bara till det repot — `DATA_REPO_TOKEN`).

**Via formuläret.** Gå till **Actions → Ändra inställningar → Run workflow**. Fyll bara i det du vill ändra — tomma fält (och valet "behåll") lämnas som de är. Funkar även i GitHub-appen i mobilen. Resultatet visas i körningens sammanfattning, och sparas till `bostadsvakt-data`.

Allt sparas i `bostadsvakt-data/config.json`, som du förstås också kan redigera direkt i det repot:

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

## Se husen i Alva

Varje körning bygger också `bostadsvakt-data/data/sida.json` — husflödet i
den generiska `{ items: [{ id, title, image, url, rader }] }`-form Alvas
"anpassade sidor" förstår (se Alva-repots `docs/FEATURES.md`). id/bild/url
är egna fält så att en favoritmarkering eller en anteckning i Alva
överlever att huset försvinner ur flödet. Bostadsvakt vet inget om Alva,
och Alva vet inget om bostadsvakt — kopplingen är bara en URL och en token,
ifylld en gång i Alvas UI, och Alva ritar upp bilder, hjärta-för-att-spara
och dölj-knapp precis som för vilken annan koppling som helst.

1. Skapa en fine-grained personal access token på
   [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens),
   scopad bara till `bostadsvakt-data`, med **Contents: read** (inget annat).
2. I Alva: **Inställningar → System → Kopplingar → Ny koppling**.
   - Namn: valfritt, t.ex. "Bostäder"
   - URL: `https://raw.githubusercontent.com/matthewholm/bostadsvakt-data/main/data/sida.json`
   - Token: den du skapade i steg 1
3. Lägg till ett kort av sorten **"Extern källa"** i en egen vy, och välj kopplingen.

`raw.githubusercontent.com` fungerar direkt mot ett privat repo när tokenen
skickas som `Authorization: Bearer` — till skillnad från GitHub:s vanliga
Contents-API (`api.github.com/repos/.../contents/...`), som svarar med filen
base64-kodad i ett JSON-svep i stället för filens egna innehåll rakt av, vilket
Alvas generiska koppling inte packar upp.

## Testa direkt på GitHub

Gå till fliken **Actions** → välj **Testa Bostadsvakt** i vänsterspalten → klicka **Run workflow**. Testet kör hela kedjan med ett låtsashus utanför Norrtälje och funkar även innan alla nycklar är på plats:

- Utan några secrets alls: loggen visar natur-kollen och notisen som text.
- Med `HA_WEBHOOK_URL` satt: du får en riktig push i mobilen inom någon minut. 📱
- Med `RESROBOT_API_KEY` satt: hållplats, turtäthet och restid testas också.

Klicka på körningen i listan för att se loggen steg för steg.

Samma workflow kör först **enhetstesterna**, som varken behöver nycklar eller internet. De täcker län-/biljettlogiken, geokodningens kommunspärr och matchningens uträkning:

```
npm test
```

## Köra lokalt (för test)

Klona [bostadsvakt-data](https://github.com/matthewholm/bostadsvakt-data) till `data-repo/` bredvid projektet (gitignorad här, precis som workflowsens checkout):

```
git clone https://github.com/matthewholm/bostadsvakt-data.git data-repo
```

`maklarkalkyl.js` styr en headless Chromium (mäklarsidorna kräver JavaScript – vanlig fetch räcker inte, se filens egen kommentar). Efter `npm install`, en gång:

```
npx playwright install chromium
```

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
