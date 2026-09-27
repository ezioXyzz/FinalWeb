import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/public/assets", { recursive: true });
await cp("cloudflare-assets", "dist/public/assets", { recursive: true });
console.log("EzioCloud artwork copied to dist/public/assets.");
