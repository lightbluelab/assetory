import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleFiles = [
  "core.js",
  "storage.js",
  "transactions.js",
  "quotes.js",
  "trends.js",
  "ui.js",
  "app.js",
];

const read = relativePath => readFile(path.join(root, relativePath), "utf8");
const replaceOnce = (source, token, value) => {
  const first = source.indexOf(token);
  if(first < 0 || first !== source.lastIndexOf(token)) {
    throw new Error(`模板占位符必须且只能出现一次：${token}`);
  }
  return source.slice(0, first) + value + source.slice(first + token.length);
};

const [trackerTemplate, trackerStyles, demoLedger, landingTemplate, landingStyles, ...modules] = await Promise.all([
  read("src/index.template.html"),
  read("src/styles.css"),
  read("demo-ledger.json"),
  read("src/landing.template.html"),
  read("src/landing.css"),
  ...moduleFiles.map(file => read(`src/js/${file}`)),
]);

const script = modules.map((source, index) => {
  const name = moduleFiles[index].replace(/\.js$/, "");
  return `// ==================== ${name} module ====================\n${source.trim()}`;
}).join("\n\n");

// Parse the same concatenated script that will be shipped before touching index.html.
new Function(script);

let trackerOutput = replaceOnce(trackerTemplate, "/*__INLINE_CSS__*/", trackerStyles.trim());
trackerOutput = replaceOnce(trackerOutput, "/*__INLINE_JS__*/", script);
trackerOutput = replaceOnce(trackerOutput, "/*__INLINE_DEMO__*/", demoLedger.trim());
trackerOutput = trackerOutput.replace(/\n*$/, "\n");
let landingOutput = replaceOnce(landingTemplate, "/*__INLINE_LANDING_CSS__*/", landingStyles.trim());
landingOutput = landingOutput.replace(/\n*$/, "\n");

const outputs = [
  [path.join(root, "index.html"), landingOutput],
  [path.join(root, "wealth-tracker.html"), trackerOutput],
];
if(process.argv.includes("--check")) {
  const checks=await Promise.all(outputs.map(async([outputPath,output])=>({path:outputPath,current:await readFile(outputPath,"utf8")})));
  const stale=checks.filter(({current},index)=>current!==outputs[index][1]);
  if(stale.length){ console.error(`${stale.map(({path})=>path.split("/").at(-1)).join("、")} 不是最新构建产物，请运行 npm run build`); process.exitCode=1; }
  else console.log("index.html 与 wealth-tracker.html 已与模块源码同步");
} else {
  await Promise.all(outputs.map(([path,output])=>writeFile(path,output)));
  console.log(`已生成 index.html（${Buffer.byteLength(landingOutput)} bytes）与 wealth-tracker.html（${Buffer.byteLength(trackerOutput)} bytes）`);
}
