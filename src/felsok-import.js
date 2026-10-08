// TILLFÄLLIG felsökning av importmejl – tas bort när importen fungerar.
// Skriver bara strukturen (längder, antal länkar, länkformat), inget innehåll.
import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const config = JSON.parse(readFileSync(new URL("../data-repo/config.json", import.meta.url), "utf8"));
const avsandare = config.importAvsandare ?? [];
const aterstall = process.argv.includes("--markera-olasta");
const client = new ImapFlow({
  host: process.env.IMAP_HOST || "imap.gmail.com", port: 993, secure: true, logger: false,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
});
await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  for (const fran of avsandare) {
    const uids = (await client.search({ from: fran, since: new Date("2026-10-08") }, { uid: true })) || [];
    console.log(`${uids.length} importmejl`);
    for (const uid of uids) {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      const m = await simpleParser(content);
      const html = m.html || "";
      const text = m.text || "";
      const hrefs = [...html.matchAll(/href=["']([^"']*)["']/gi)].map((x) => x[1]);
      const maska = (h) => h.replace(/[a-z0-9]{6,}/gi, (s) => (/^\d+$/.test(s) ? "<id>" : s.length > 25 ? "<lång>" : s)).slice(0, 140);
      console.log(`\n--- "${m.subject}" uid ${uid}`);
      console.log(`html ${html.length} tecken, text ${text.length} tecken, bilagor: ${m.attachments.map((a) => `${a.contentType} ${a.size}`).join(", ") || "inga"}`);
      console.log(`<a>: ${(html.match(/<a\b/gi) || []).length}, href: ${hrefs.length}, med "bostad": ${hrefs.filter((h) => /bostad/i.test(h)).length}, med "hemnet": ${hrefs.filter((h) => /hemnet/i.test(h)).length}`);
      console.log(`"hemnet" i html/text: ${(html.match(/hemnet/gi) || []).length}/${(text.match(/hemnet/gi) || []).length}, "/bostad/" i text: ${(text.match(/\/bostad\//gi) || []).length}, " kr" i text: ${(text.match(/\d kr/g) || []).length}`);
      console.log(`exempel-href:\n  ${[...new Set(hrefs.map(maska))].slice(0, 8).join("\n  ")}`);
      const ix = html.search(/\d\s*kr/);
      if (ix > 0) console.log(`taggar runt första priset: ${html.slice(Math.max(0, ix - 600), ix + 40).replace(/>[^<]{3,}</g, ">…<").replace(/"[^"]{30,}"/g, '"…"')}`);
      if (aterstall) await client.messageFlagsRemove(String(uid), ["\Seen"], { uid: true });
    }
  }
  if (aterstall) console.log("\nMejlen markerade som olästa igen.");
} finally {
  lock.release();
  await client.logout();
}
