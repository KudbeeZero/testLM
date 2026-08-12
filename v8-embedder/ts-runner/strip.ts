import fs from "fs";
import path from "path";

async function stripFile(inPath: string, outPath: string) {
  const ts = await import("typescript");
  const src = fs.readFileSync(inPath, "utf8");
  const { outputText: code } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      removeComments: true
    }
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, code, "utf8");
  console.log(`stripped ${inPath} -> ${outPath}`);
}

const [,, inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: node strip.js input.ts output.js");
  process.exit(2);
}
stripFile(inPath, outPath).catch((e) => { console.error(e); process.exit(1); });
