// Skickar push-notiser via ntfy.sh. Utan NTFY_TOPIC loggas notisen bara i konsolen.
export async function notis({ titel, meddelande, lank }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`\n[TORRKÖRNING – ingen NTFY_TOPIC satt]\n${titel}\n${meddelande}\n${lank ?? ""}`);
    return;
  }
  const res = await fetch("https://ntfy.sh", {
    method: "POST",
    body: JSON.stringify({
      topic,
      title: titel,
      message: meddelande,
      click: lank,
      tags: ["house_with_garden"],
    }),
  });
  if (!res.ok) {
    console.warn(`ntfy svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
