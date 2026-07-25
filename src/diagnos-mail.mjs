// Engångsdiagnostik: hämtar råa HTML:en för de senaste Hemnet-/Booli-mejlen
// (oavsett läst-status) så parsern kan byggas mot verklig struktur istället
// för att gissas fram från en skärmdump. Tas bort efter felsökningen.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const client = new ImapFlow({
  host: process.env.IMAP_HOST || "imap.gmail.com",
  port: 993,
  secure: true,
  logger: false,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
});

await client.connect();
const lock = await client.getMailboxLock("INBOX");
try {
  const sedan = new Date();
  sedan.setDate(sedan.getDate() - 3);
  const uids = (await client.search({ since: sedan }, { uid: true })) || [];
  console.log(`${uids.length} mejl senaste 3 dagarna.`);

  const traffar = [];
  for (const uid of uids) {
    const { content } = await client.download(String(uid), undefined, { uid: true });
    const mail = await simpleParser(content);
    const avsandare = (mail.from?.text ?? "").toLowerCase();
    if (!/hemnet|booli/.test(avsandare)) continue;
    traffar.push({ uid, avsandare, amne: mail.subject, datum: mail.date, html: mail.html || "", text: mail.text || "" });
  }
  traffar.sort((a, b) => new Date(b.datum) - new Date(a.datum));

  console.log(`\n${traffar.length} Hemnet/Booli-mejl hittade:`);
  for (const t of traffar) {
    console.log(`  uid=${t.uid} | ${t.datum?.toISOString()} | ${t.avsandare} | "${t.amne}" | ${t.html.length} tecken HTML`);
  }

  const vald = process.argv[2] ? traffar.find((t) => String(t.uid) === process.argv[2]) : traffar[0];
  if (vald) {
    console.log(`\n===== RÅ TEXT (uid=${vald.uid}, "${vald.amne}") =====\n`);
    console.log(vald.text);
    console.log(`\n===== SLUT TEXT =====`);
    console.log(`\n===== RÅ HTML (uid=${vald.uid}, "${vald.amne}") =====\n`);
    console.log(vald.html);
    console.log(`\n===== SLUT HTML =====`);
  }
} finally {
  lock.release();
  await client.logout();
}
