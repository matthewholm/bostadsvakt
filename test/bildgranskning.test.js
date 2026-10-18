// Nätfria tester för bildgranskningen: vilka bilder som plockas ur en sida,
// vilka som får följa med till Claude, hur anropet ser ut och hur svaret blir
// rader i Alva. Själva modellens omdöme går inte att testa här; det som går
// att testa är allt runt omkring, och det är där ett tyst fel annars gömmer
// sig (en logga som granskas som ett hus, en bild för stor för API:t).
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

import { hittaBilder } from "../src/bilder.js";
import {
  bildInfo, valjBilder, granskaBilder, bildgranskningRader, bildgranskningNotis, MODELL,
} from "../src/bildgranskning.js";
import { booliAdress, annonsenGaller, annonsMarkor } from "../src/objektsida.js";

const SIDA = `<!doctype html><html><head>
<meta property="og:image" content="https://bilder.example.se/images/cut/aa/01.jpg">
</head><body>
<img src="https://bilder.example.se/images/cut/aa/01.jpg" srcset="https://bilder.example.se/images/small/aa/01.jpg 400w">
<img src="/static/logo-site.svg"><img src="https://bilder.example.se/images/broker_logo/x.png">
<img data-src="//bilder.example.se/images/cut/aa/02.webp">
<script>window.__D={"images":[{"url":"https:\\u002F\\u002Fbilder.example.se\\u002Fimages\\u002Fcut\\u002Faa\\u002F03.jpg"}]}</script>
</body></html>`;

test("hittaBilder tar husets foton i sidans ordning och hoppar över loggor", () => {
  assert.deepEqual(hittaBilder(SIDA, "https://www.example.se/bostad/1"), [
    "https://bilder.example.se/images/cut/aa/01.jpg",
    "https://bilder.example.se/images/cut/aa/02.webp",
    "https://bilder.example.se/images/cut/aa/03.jpg",
  ]);
});

test("hittaBilder väljer den största varianten av samma foto", () => {
  const html = `<img srcset="https://b.se/i/400x300/x.jpg 400w, https://b.se/i/1600x1200/x.jpg 1600w">`;
  assert.deepEqual(hittaBilder(html), ["https://b.se/i/1600x1200/x.jpg"]);
});

test("hittaBilder ger en tom lista för en sida utan foton", () => {
  assert.deepEqual(hittaBilder("<p>Häckgränd 8, pantbrev 1 200 000 kr</p>"), []);
});

// Minsta möjliga filer, med måtten skrivna där formaten lägger dem.
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);

test("bildInfo läser format och mått ur filen själv", () => {
  assert.deepEqual(bildInfo(png(1200, 800)), { typ: "image/png", bredd: 1200, hojd: 800 });
  assert.deepEqual(bildInfo(jpg(2400, 1600)), { typ: "image/jpeg", bredd: 2400, hojd: 1600 });
  assert.equal(bildInfo(Buffer.from("<html>nej</html>")), null);
});

const bild = (i, w = 1600, h = 1067) => {
  const data = jpg(w, h);
  return { url: `https://b.se/${i}.jpg`, data, info: bildInfo(data) };
};

test("valjBilder skickar upp till 40 bilder när alla är högst 2000 px", () => {
  const valda = valjBilder(Array.from({ length: 55 }, (_, i) => bild(i)));
  assert.equal(valda.length, 40);
  assert.equal(valda[0].url, "https://b.se/0.jpg");
});

test("valjBilder tar 20 stora bilder hellre än bara de små, när de stora är fler", () => {
  // API:t vägrar bilder över 2000 px när fler än 20 skickas.
  const lista = [...Array.from({ length: 30 }, (_, i) => bild(i, 2400, 1600)), bild(99)];
  const valda = valjBilder(lista);
  assert.equal(valda.length, 20);
  assert.ok(valda.every((b) => b.info.bredd === 2400));
});

test("valjBilder släpper aldrig igenom fler än 20 bilder om någon är större än 2000 px", () => {
  const lista = Array.from({ length: 30 }, (_, i) => (i % 2 ? bild(i, 2400, 1600) : bild(i)));
  const valda = valjBilder(lista);
  const stor = valda.some((b) => Math.max(b.info.bredd, b.info.hojd) > 2000);
  assert.ok(!stor || valda.length <= 20, `${valda.length} bilder med minst en över 2000 px`);
});

const SVAR = {
  helhet: "varning",
  sammanfattning: "Källaren visar missfärgning längs golvet. Fasaden ser nyligen målad ut.",
  fynd: [
    { bild: 1, var: "Fasad", ton: "bra", vad: "Nymålad träfasad", kolla: null },
    { bild: 7, var: "Källare", ton: "varning", vad: "Mörka fläckar längs golvlisten, kan tyda på fukt", kolla: "Fråga om fuktmätning gjorts" },
    { bild: null, var: "Badrum", ton: "notera", vad: "Texten säger renoverat 1998", kolla: "Fråga om tätskiktet" },
  ],
  pris: null,
  syns_inte: ["vind", "tak"],
};

function falskKlient() {
  const skickat = [];
  const klient = new Anthropic({
    apiKey: "test",
    fetch: async (url, init) => {
      skickat.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: MODELL, stop_reason: "end_turn", stop_details: null,
          content: [{ type: "text", text: JSON.stringify(SVAR) }], usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { klient, skickat };
}

test("granskaBilder skickar numrerade bilder, fallback och strukturerat svar till rätt modell", async () => {
  const { klient, skickat } = falskKlient();
  const g = await granskaBilder({ bilder: [bild(1), bild(2)], adress: "Häckgränd 8", fakta: ["Pris: 4 250 000 kr"] }, { klient });
  assert.equal(skickat.length, 1);
  const { headers, body } = skickat[0];
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.match(headers.get("anthropic-beta"), /server-side-fallback-2026-07-01/);
  assert.equal(body.output_config.format.type, "json_schema");
  const typer = body.messages[0].content.map((c) => c.type);
  assert.deepEqual(typer, ["text", "image", "text", "image", "text"]);
  assert.equal(body.messages[0].content[0].text, "Bild 1:");
  assert.match(body.messages[0].content.at(-1).text, /Pris: 4 250 000 kr/);
  assert.equal(g.helhet, "varning");
  assert.equal(g.antalBilder, 2);
});

test("granskaBilder ringer inte alls utan bilder", async () => {
  const { klient, skickat } = falskKlient();
  assert.equal(await granskaBilder({ bilder: [] }, { klient }), null);
  assert.equal(skickat.length, 0);
});

test("raderna sätter varningar först, med bildnummer, och säger att det inte är en besiktning", () => {
  const rader = bildgranskningRader({ ...SVAR, antalBilder: 31, granskad: "2026-10-18T10:00:00Z" });
  assert.equal(rader[0], "⚠ Bilderna visar varningstecken");
  assert.equal(rader[2], "31 bilder granskade 2026-10-18. Inte en besiktning.");
  assert.equal(rader[3], "⚠ Källare: Mörka fläckar längs golvlisten, kan tyda på fukt (bild 7)");
  assert.equal(rader[4], "Kolla: Fråga om fuktmätning gjorts");
  assert.ok(rader.includes("✓ Fasad: Nymålad träfasad (bild 1)"));
  assert.ok(rader.includes("Badrum: Texten säger renoverat 1998"));
  // Alva ritar rader över 120 tecken som löptext; ett fynd ska vara en rad.
  for (const r of rader.slice(3)) assert.ok(r.length <= 120, r);
});

test("notisen bär bara helheten, sammanfattningen och varningarna", () => {
  assert.deepEqual(bildgranskningNotis(SVAR), [
    "⚠ Bilderna visar varningstecken",
    SVAR.sammanfattning,
    "⚠ Källare: Mörka fläckar längs golvlisten, kan tyda på fukt",
  ]);
  assert.deepEqual(bildgranskningRader(null), []);
});

test("booliAdress läser gatan ur sidans inbäddade data, rubriken som reserv", () => {
  assert.deepEqual(booliAdress(`<script>{"streetAddress":"Häckgränd 8","municipalityName":"Norrtälje"}</script>`), { gata: "Häckgränd 8", ort: "Norrtälje" });
  assert.deepEqual(booliAdress("<h1 class='x'>Storgatan  3</h1>"), { gata: "Storgatan 3", ort: "" });
  assert.equal(booliAdress("<p>ingen adress</p>"), null);
});

test("en kvarglömd annons.html följer aldrig med en annan länk", () => {
  const lank = "https://www.hemnet.se/bostad/villa-5rum-x-21234567";
  const fil = `${annonsMarkor(lank + "?utm_source=app")}\n<html></html>`;
  assert.equal(annonsenGaller(fil, lank), true);
  assert.equal(annonsenGaller(fil, "https://www.hemnet.se/bostad/villa-annan-29999999"), false);
  assert.equal(annonsenGaller("<html></html>", lank), false);
});
