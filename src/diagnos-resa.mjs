// Engångsdiagnostik: anropar ResRobots trip-API direkt (rått svar, inte
// bara det tolkade resultatet) för exakta koordinater, för att se VARFÖR
// resaTillStockholm gav null för ett visst hus. Tas bort efter felsökningen.
import { resaTillStockholm } from "./transit.js";

const lat = process.argv[2] ?? "59.7721143";
const lon = process.argv[3] ?? "18.2379921";

const params = new URLSearchParams({
  originCoordLat: lat,
  originCoordLong: lon,
  destId: "740000001",
  format: "json",
  accessId: process.env.RESROBOT_API_KEY,
});
const res = await fetch(`https://api.resrobot.se/v2.1/trip?${params}`);
console.log(`Rått anrop (utan datum/tid) – status: ${res.status}`);
console.log(JSON.stringify(await res.json(), null, 2).slice(0, 3000));

console.log("\n--- resaTillStockholm (med vardagsmorgon-datum) ---");
const resa = await resaTillStockholm(Number(lat), Number(lon));
console.log(JSON.stringify(resa, null, 2));
