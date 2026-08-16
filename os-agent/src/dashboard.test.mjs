import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, "..", "dashboard", "index.html");

// Guard: a single JS syntax error in the inline dashboard script would break
// the ENTIRE Control Room. This test parses the inline <script> so any
// syntax regression fails the suite before it can ship.
test("dashboard inline JavaScript is syntactically valid", async () => {
  const html = await readFile(INDEX, "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(m).toBeTruthy();
  expect(() => new Function(m[1])).not.toThrow();
});

test("dashboard serves the required Control Room sections", async () => {
  const html = await readFile(INDEX, "utf8");
  for (const section of [
    "Local Agent",
    "Morning Report",
    "Local Routing Intelligence",
    "Model Benchmark",
    "Adaptive Routing",
    "HERMES Execution",
  ]) {
    expect(html).toContain(section);
  }
});
