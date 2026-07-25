// Engångsdiagnostik: kör resaTillStockholm mot en riktig adress och skriv ut
// hela svaret rått, så man kan se med egna ögon att förbeställnings- och
// operatörsvarningarna faktiskt triggar mot skarp ResRobot-data. Tas bort
// efter verifiering – hör inte till den vanliga bevakningen.
import { geokoda } from "./geocode.js";
import { resaTillStockholm } from "./transit.js";

const adress = process.argv[2] ?? "Undravägen 39, Norrtälje";
const pos = await geokoda(adress);
console.log(`Adress: ${adress}`);
console.log(`Koordinater: ${pos?.lat}, ${pos?.lon}`);
if (!pos) process.exit(1);

const resa = await resaTillStockholm(pos.lat, pos.lon);
console.log("\nresaTillStockholm-resultat:");
console.log(JSON.stringify(resa, null, 2));
