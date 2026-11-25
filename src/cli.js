// Run without Electron: `npm run server`, then open http://localhost:4949/host.
// Keys come from OPENAI_API_KEY / DEEPGRAM_API_KEY or are saved (unencrypted,
// owner-only file permissions) in ~/.speaktoall-local/settings.json.
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.js";
import { startServer } from "./server.js";

const port = Number(process.env.PORT) || 4949;
const store = createStore({ file: join(homedir(), ".speaktoall-local", "settings.json") });
const app = await startServer({ store, port });

console.log(`\nSpeak To All is running.\n`);
console.log(`  Host controls (this computer only): http://localhost:${app.port}/host`);
for (const { name, url } of await app.shareLinks()) {
  console.log(`  Listeners on the same WiFi (${name}):  ${url}`);
}
console.log("\nPress Ctrl+C to stop.\n");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
