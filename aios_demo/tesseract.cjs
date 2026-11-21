// Offline fallback. Use the same Tesseract engine and TSV coordinates as the CLI.
const fs = require("node:fs");
const path = require("node:path");
const library = require.resolve("tesseract.js", {
  paths: [__dirname, path.dirname(process.execPath)],
});
const { createWorker } = require(library);
const header =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

async function run() {
  const input = fs.readFileSync(0);
  const worker = await createWorker("ind", 1, {
    langPath: path.join(__dirname, "tessdata"),
    cacheMethod: "none",
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: process.argv[2] || "6",
      tessedit_char_whitelist: process.argv[3] || "",
    });
    const result = await worker.recognize(input, {}, { text: false, tsv: true });
    process.stdout.write(header + "\n" + result.data.tsv);
  } finally {
    await worker.terminate();
  }
}
run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
