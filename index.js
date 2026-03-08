const http = require("http");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = "./pages";
const IMAGE_DIR = "./images";
const cache = new Map();

const SIZE_MAP = { "1": 1, "2": 0.85, "3": 0.7 };

function applySize(tag, size, content, type = "text") {
  const s = SIZE_MAP[size] || 1;
  if (type === "header") return `<${tag}>${content}</${tag}>`;
  if (type === "link") return `<p style="font-size:${s}em">${content}</p>`;
  if (type === "image") {
    let width;
    if (size === "1") width = "50%";
    else if (size === "2") width = "35%";
    else if (size === "3") width = "20%";
    else width = "50%";
    return `<img src="${content}" style="width:${width}; max-width:100%;">`;
  }
  return `<p style="font-size:${s}em">${content}</p>`;
}

function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inString = !inString;
    else if (c === "#" && !inString) return line.slice(0, i).trim();
  }
  return line.trim();
}

function compileStructa(src, filePath) {
  const lines = src.split("\n");
  let title = "";
  let favicon = "";
  let bg = "#000000";
  let fg = "#ffffff";
  let align = "left";
  let metaCount = 0;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    line = stripComment(line);
    if (!line) continue;

    if (line.startsWith('-"')) {
      const end = line.lastIndexOf('"');
      if (end <= 2) throw new Error(`Malformed meta line in ${filePath} line ${i + 1}`);
      const val = line.slice(2, end);
      if (metaCount === 0) title = val;
      else favicon = val;
      metaCount++;
      continue;
    }

    if (line.startsWith("=bg:")) { bg = line.slice(4).replace(/"/g, "").trim(); continue; }
    if (line.startsWith("=fg:")) { fg = line.slice(4).replace(/"/g, "").trim(); continue; }
    if (line.startsWith("=align:")) {
      let a = line.slice(7).trim().toUpperCase();
      if (a === "MIDDLE") a = "CENTER";
      if (["CENTER", "LEFT", "RIGHT"].includes(a)) align = a.toLowerCase();
      else throw new Error(`Invalid alignment '${a}' in ${filePath} line ${i + 1}`);
      continue;
    }

    const join = line.endsWith("!");
    if (join) line = line.slice(0, -1);

    const first = line[0];
    const size = line[2];

    try {
      if (first === "{" || first === "[") {
        const q1 = line.indexOf('"');
        const q2 = line.lastIndexOf('"');
        if (q1 === -1 || q2 === q1) throw new Error("Missing quotes for text");
        const text = line.slice(q1 + 1, q2).replace(/`/g, "\\`");
        if (first === "{") out.push(applySize("h1", size, text, "header") + (join ? "" : "\n"));
        else out.push(applySize("", size, text, "text") + (join ? "" : "\n"));
      } else if (first === "(") {
        const lb = line.indexOf("[");
        const rb = line.indexOf("]");
        if (lb === -1 || rb === -1) throw new Error("Missing [ ] for link");
        const href = line.slice(lb + 1, rb);
        const text = line.slice(rb + 1).replace(/`/g, "\\`");
        const linkHtml = href.startsWith("http") 
          ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` 
          : `<a href="/${href}">${text}</a>`;
        out.push(applySize("", size, linkHtml, "link") + (join ? "" : "\n"));
      } else if (first === "<") {
        const lb = line.indexOf("[");
        const rb = line.indexOf("]");
        if (lb === -1 || rb === -1) throw new Error("Missing [ ] for image");
        const src = line.slice(lb + 1, rb).trim();
        if (!/\.(png|jpe?g)$/i.test(src)) throw new Error(`Unsupported image extension '${src}'`);
        out.push(applySize("", size, `/images/${src}`, "image") + (join ? "" : "\n"));
      }
    } catch (e) {
      throw new Error(`Structa error in ${filePath} line ${i + 1}: ${e.message}`);
    }
  }

  return function() {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
${favicon ? `<link rel="icon" href="${favicon}">` : ""}
</head>
<body style="background-color:${bg}; color:${fg}; text-align:${align};">
${out.join("\n")}
</body>
</html>`;
  };
}

async function loadPage(file) {
  const stat = await fs.stat(file);
  const cached = cache.get(file);
  if (cached && cached.mtime === stat.mtimeMs) return cached.fn;
  const src = await fs.readFile(file, "utf8");
  const fn = compileStructa(src, file);
  cache.set(file, { fn, mtime: stat.mtimeMs });
  return fn;
}

async function serveImage(filePath, res) {
  try {
    await fs.access(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000"
    });
    const stream = fsSync.createReadStream(filePath);
    stream.pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Image not found");
  }
}

http.createServer(async (req, res) => {
  try {
    let route = req.url.split("?")[0];

    if (route.startsWith("/images/")) {
      const imgFile = path.join(IMAGE_DIR, route.replace("/images/", ""));
      return serveImage(imgFile, res);
    }

    if (route === "/") route = "/index";
    const file = path.join(ROOT, route + ".stc");
    try { await fs.access(file); } catch { res.writeHead(404); return res.end("Structa page not found"); }

    const page = await loadPage(file);
    const html = page();

    res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
    const gzip = zlib.createGzip();
    gzip.pipe(res);
    gzip.end(html);

  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(e.message);
  }
}).listen(8080);

console.log("Structa server running on http://localhost:8080");