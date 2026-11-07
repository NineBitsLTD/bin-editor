// A test stand for the webview in a browser (no VS Code): serves dist/ and index.html, and the
// webview's texts as BinEditor._strings would give them in Russian (from the source and the l10n
// bundle).   node test/harness/server.mjs [port]  →  http://127.0.0.1:3399/
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const port = Number(process.argv[2]) || 3399;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function strings() {
    const src = fs.readFileSync(path.join(root, 'src/components/BinEditor.js'), 'utf8');
    const ru = JSON.parse(fs.readFileSync(path.join(root, 'l10n/bundle.l10n.ru.json'), 'utf8'));
    const block = src.slice(src.indexOf('static _strings()'));
    const out = {};
    for (const m of block.matchAll(/(\w+): t\('([^']*)'((?:, key\('\w'\))*)\)/g)) {
        const keys = [...m[3].matchAll(/key\('(\w)'\)/g)].map(k => `⌘${k[1]}`);
        out[m[1]] = (ru[m[2]] ?? m[2]).replace(/\{(\d+)\}/g, (s, i) => keys[i] ?? s);
    }
    return out;
}

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/strings.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(strings()));
    }
    const rel = url.pathname === '/' ? 'test/harness/index.html' : url.pathname.slice(1);
    const file = path.join(root, rel);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
