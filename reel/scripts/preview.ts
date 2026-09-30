import "dotenv/config";
import { execSync } from "node:child_process";

console.log("🎬 Avvio Remotion Studio...\n");
execSync("pnpm remotion studio remotion/index.ts", {
  stdio: "inherit",
  cwd: new URL("..", import.meta.url).pathname,
});
