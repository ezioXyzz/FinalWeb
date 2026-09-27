import { build } from "vite";

process.env.CLOUDFLARE_BUILD = "1";
process.env.VITE_CLOUDFLARE_DEPLOYMENT = "true";

await build({ mode: "production" });
// Vite empties dist/public during build, so import the copy helper afterward.
await import("./copy-deployment-assets.mjs");
