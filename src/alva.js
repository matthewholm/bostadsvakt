// Alva is where bostadsvakt's state actually lives now: criteria, the
// household's economy, and the feed itself. This used to be config.json and
// data/traffar.json, committed to this repository on every run — the wrong
// home the moment config.json was going to carry a household's income and
// savings, committed to git every 30 minutes, in a repository meant to go
// public one day. Alva already has a private database and the same
// ingest-token pattern the push-notification chain uses, so bostadsvakt
// authenticates the same way an automation already does there: a bearer
// token, opening exactly the two routes below and nothing else.
export function harAlva() {
  return Boolean(process.env.ALVA_URL && process.env.ALVA_INGEST_TOKEN);
}

const bas = () => String(process.env.ALVA_URL).replace(/\/$/, "");
const headers = () => ({
  Authorization: `Bearer ${process.env.ALVA_INGEST_TOKEN}`,
  "Content-Type": "application/json",
});

/** Criteria, the household's economy, and the feed as Alva last knew it. */
export async function hamtaTillstand() {
  const res = await fetch(`${bas()}/api/bostadsvakt/ingest/config`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Alva svarade ${res.status} på /ingest/config: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  return {
    // The whole document (searches + kriterier + notiser), named for what
    // it is — "config", not "kriterier", which is also the name of one
    // field inside it.
    config: body.config ?? null,
    hushall: body.hushall ?? null,
    hus: Array.isArray(body.houses) ? body.houses : [],
  };
}

/**
 * Replaces the whole feed with this run's result — same "always the full
 * list, never a diff" contract `data/traffar.json` had, so a house the
 * watcher stopped tracking actually disappears instead of lingering because
 * nothing told Alva to forget it.
 */
export async function skickaHus(husLista) {
  const res = await fetch(`${bas()}/api/bostadsvakt/ingest/houses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(husLista),
  });
  if (!res.ok) {
    throw new Error(`Alva svarade ${res.status} på /ingest/houses: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}
