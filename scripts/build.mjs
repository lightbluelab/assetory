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
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[character]));
const inlineMarkdown = value => escapeHtml(value)
  .replace(/`([^`]+)`/g,"<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
  .replace(/\*([^*]+)\*/g,"<em>$1</em>")
  .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g,'<a href="$2">$1</a>');
const renderGuide = markdown => {
  const output=[], paragraph=[], list=[];
  let listType=null, codeLines=null;
  const flushParagraph=()=>{ if(paragraph.length) output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`),paragraph.length=0; };
  const flushList=()=>{ if(list.length) output.push(`<${listType}>${list.map(item=>`<li>${inlineMarkdown(item)}</li>`).join("")}</${listType}>`),list.length=0,listType=null; };
  for(const line of markdown.replace(/\r\n/g,"\n").split("\n")){
    if(line.startsWith("```")){
      if(codeLines){ output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`); codeLines=null; }
      else { flushParagraph(); flushList(); codeLines=[]; }
      continue;
    }
    if(codeLines){ codeLines.push(line); continue; }
    const heading=line.match(/^(#{1,3})\s+(.+)$/);
    const unordered=line.match(/^[-*]\s+(.+)$/), ordered=line.match(/^\d+\.\s+(.+)$/);
    if(heading){ flushParagraph(); flushList(); output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); }
    else if(unordered||ordered){ flushParagraph(); const nextType=unordered?"ul":"ol"; if(listType&&listType!==nextType) flushList(); listType=nextType; list.push((unordered||ordered)[1]); }
    else if(!line.trim()){ flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line.trim()); }
  }
  flushParagraph(); flushList();
  return output.join("\n");
};

const [trackerTemplate, trackerStyles, landingTemplate, landingStyles, guideTemplate, readme, ...modules] = await Promise.all([
  read("src/index.template.html"),
  read("src/styles.css"),
  read("src/landing.template.html"),
  read("src/landing.css"),
  read("src/guide.template.html"),
  read("README.md"),
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
trackerOutput = trackerOutput.replace(/\n*$/, "\n");
let landingOutput = replaceOnce(landingTemplate, "/*__INLINE_LANDING_CSS__*/", landingStyles.trim());
landingOutput = landingOutput.replace(/\n*$/, "\n");
let guideOutput = replaceOnce(guideTemplate, "/*__GUIDE_CONTENT__*/", renderGuide(readme));
guideOutput = guideOutput.replace(/\n*$/, "\n");

const outputs = [
  [path.join(root, "index.html"), landingOutput],
  [path.join(root, "assetory.html"), trackerOutput],
  [path.join(root, "guide.html"), guideOutput],
];
if(process.argv.includes("--check")) {
  const checks=await Promise.all(outputs.map(async([outputPath,output])=>({path:outputPath,current:await readFile(outputPath,"utf8")})));
  const stale=checks.filter(({current},index)=>current!==outputs[index][1]);
  if(stale.length){ console.error(`${stale.map(({path})=>path.split("/").at(-1)).join("、")} 不是最新构建产物，请运行 npm run build`); process.exitCode=1; }
  else console.log("index.html、assetory.html 与 guide.html 已与模块源码同步");
} else {
  await Promise.all(outputs.map(([path,output])=>writeFile(path,output)));
  console.log(`已生成 index.html（${Buffer.byteLength(landingOutput)} bytes）、assetory.html（${Buffer.byteLength(trackerOutput)} bytes）与 guide.html（${Buffer.byteLength(guideOutput)} bytes）`);
}
