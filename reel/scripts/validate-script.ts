import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ReelScriptSchema } from "../src/schemas/script.js";

const scriptPath = process.argv[2];

if (!scriptPath || scriptPath === "-h" || scriptPath === "--help") {
  console.error("Usage: pnpm validate-script <path-to-script.json>");
  process.exit(scriptPath ? 0 : 1);
}

const abs = resolve(scriptPath);

try {
  const raw = await readFile(abs, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    console.error("❌ Invalid JSON:", (e as Error).message);
    process.exit(1);
  }

  const parsed = ReelScriptSchema.safeParse(json);
  if (!parsed.success) {
    console.error("❌ script.json failed ReelScriptSchema validation:\n");
    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      console.error(`  • ${path}: ${issue.message}`);
    }
    process.exit(1);
  }

  const s = parsed.data;
  console.log("✅ script.json OK");
  console.log(`   hook: ${s.hook.slice(0, 80)}${s.hook.length > 80 ? "…" : ""}`);
  console.log(`   scenes: ${s.scenes?.length ?? 0}`);
  process.exit(0);
} catch (e) {
  console.error("❌", (e as Error).message);
  process.exit(1);
}
