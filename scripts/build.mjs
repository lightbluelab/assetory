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

const [template, styles, ...modules] = await Promise.all([
  read("src/index.template.html"),
  read("src/styles.css"),
  ...moduleFiles.map(file => read(`src/js/${file}`)),
]);

const script = modules.map((source, index) => {
  const name = moduleFiles[index].replace(/\.js$/, "");
  return `// ==================== ${name} module ====================\n${source.trim()}`;
}).join("\n\n");

// Parse the same concatenated script that will be shipped before touching index.html.
new Function(script);

let output = replaceOnce(template, "/*__INLINE_CSS__*/", styles.trim());
output = replaceOnce(output, "/*__INLINE_JS__*/", script);
output = output.replace(/\n*$/, "\n");

const outputPath = path.join(root, "index.html");
if(process.argv.includes("--check")) {
  const current = await read("index.html");
  if(current !== output) {
    console.error("index.html 不是最新构建产物，请运行 npm run build");
    process.exitCode = 1;
  } else {
    console.log("index.html 已与模块源码同步");
  }
} else {
  await writeFile(outputPath, output);
  console.log(`已生成 index.html（${Buffer.byteLength(output)} bytes）`);
}
