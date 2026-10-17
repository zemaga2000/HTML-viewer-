/**
 * Preparação de HTML para funcionar offline.
 *
 * - Aceita ficheiros completos, fragmentos ou texto copiado com ```html ... ```
 * - Garante <meta charset> (acentos corretos) e <meta viewport> (escala certa no iPhone)
 * - Descarrega scripts e folhas de estilo de CDNs e embute-os no próprio ficheiro,
 *   para que o HTML funcione depois sem internet.
 */
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const ESM_REMOTE_IMPORT = /\bimport\s*(?:[^'"();]*?\bfrom\s*)?\(?\s*["'](?:https?:)?\/\/[^"']+["']/g;
const FETCH_TIMEOUT_MS = 15000;
// ---------- utilitários ----------
function attr(attrs, name) {
    const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
    const m = attrs.match(re);
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}
const isRemote = (u) => /^(https?:)?\/\//i.test(u.trim());
const absolutize = (u) => {
    const t = u.trim();
    return t.startsWith('//') ? `https:${t}` : t;
};
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
function decodeEntities(s) {
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&(#39|apos);/g, "'")
        .replace(/&amp;/g, '&');
}
/** Resolve um URL relativo contra um URL base (o URL do RN não é fiável para isto). */
export function resolveUrl(rel, base) {
    const m = base.match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?/i);
    if (!m)
        return rel;
    const origin = m[1];
    if (rel.startsWith('/'))
        return origin + rel;
    const basePath = m[2] || '/';
    const dir = basePath.slice(0, basePath.lastIndexOf('/') + 1);
    const out = [];
    for (const part of (dir + rel).split('/')) {
        if (part === '..') {
            if (out.length > 1)
                out.pop();
        }
        else if (part !== '.') {
            out.push(part);
        }
    }
    return origin + out.join('/');
}
async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return await res.text();
    }
    finally {
        clearTimeout(timer);
    }
}
// ---------- deteção ----------
export function looksLikeHtml(text) {
    return /<(!doctype\s+html|html|head|body|div|main|section|article|script|style|svg|canvas|h1|p)\b/i.test(text);
}
export function extractTitle(html) {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m)
        return null;
    const t = decodeEntities(m[1].replace(/\s+/g, ' ').trim());
    return t || null;
}
/** Texto copiado de uma resposta do Claude pode vir dentro de ```html ... ``` */
export function stripFences(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('<'))
        return trimmed;
    const m = trimmed.match(/```[a-z]*\s*\n([\s\S]*?)```/i);
    return m ? m[1].trim() : trimmed;
}
function remoteScriptSrc(attrs, body) {
    const src = attr(attrs, 'src');
    if (!src || !isRemote(src) || body.trim())
        return null;
    // Módulos ES importam outros ficheiros por caminhos relativos ao CDN: não dá para embutir.
    if ((attr(attrs, 'type') || '').toLowerCase() === 'module')
        return null;
    return absolutize(src);
}
function remoteStylesheetHref(tag) {
    const rel = (attr(tag, 'rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet'))
        return null;
    const href = attr(tag, 'href');
    if (!href || !isRemote(href))
        return null;
    return absolutize(href);
}
/** Quantos recursos ainda dependem da internet. */
export function countExternal(html) {
    let n = 0;
    html.replace(SCRIPT_TAG, (m, attrs) => {
        const src = attr(attrs, 'src');
        if (src && isRemote(src))
            n++;
        return m;
    });
    html.replace(LINK_TAG, (tag) => {
        if (remoteStylesheetHref(tag))
            n++;
        return tag;
    });
    n += (html.match(ESM_REMOTE_IMPORT) || []).length;
    return n;
}
// ---------- normalização ----------
function ensureDocument(html) {
    if (/<html[\s>]/i.test(html) || /<!doctype/i.test(html))
        return html;
    return `<!DOCTYPE html>\n<html>\n<head></head>\n<body>\n${html}\n</body>\n</html>`;
}
function injectIntoHead(html, tags) {
    if (!tags)
        return html;
    const head = html.match(/<head\b[^>]*>/i);
    if (head && head.index !== undefined) {
        const i = head.index + head[0].length;
        return `${html.slice(0, i)}\n${tags}${html.slice(i)}`;
    }
    const htmlTag = html.match(/<html\b[^>]*>/i);
    if (htmlTag && htmlTag.index !== undefined) {
        const i = htmlTag.index + htmlTag[0].length;
        return `${html.slice(0, i)}\n<head>\n${tags}\n</head>${html.slice(i)}`;
    }
    const doctype = html.match(/<!doctype[^>]*>/i);
    if (doctype && doctype.index !== undefined) {
        const i = doctype.index + doctype[0].length;
        return `${html.slice(0, i)}\n${tags}${html.slice(i)}`;
    }
    return `${tags}\n${html}`;
}
// ---------- embutir recursos ----------
function cleanScriptAttrs(attrs) {
    return attrs
        .replace(/\s+(src|integrity|crossorigin|referrerpolicy|defer|async)\b(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
        .replace(/\s*\/\s*$/, '');
}
function absolutizeCssUrls(css, base) {
    return css
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, p) => {
        const path = p.trim();
        if (path.startsWith('//'))
            return `url(${q}https:${path}${q})`;
        if (/^(data:|https?:|#|blob:)/i.test(path))
            return m;
        return `url(${q}${resolveUrl(path, base)}${q})`;
    })
        .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, p) => isRemote(p) || /^data:/i.test(p) ? m : `@import ${q}${resolveUrl(p, base)}${q}`);
}
/** Para código embutido não fechar o <script> antes do tempo. */
function escapeScriptBody(code) {
    return code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\x21--');
}
export async function inlineExternal(html) {
    const urls = new Set();
    html.replace(SCRIPT_TAG, (m, attrs, body) => {
        const u = remoteScriptSrc(attrs, body);
        if (u)
            urls.add(u);
        return m;
    });
    html.replace(LINK_TAG, (tag) => {
        const u = remoteStylesheetHref(tag);
        if (u)
            urls.add(u);
        return tag;
    });
    if (urls.size === 0)
        return html;
    const fetched = new Map();
    await Promise.all([...urls].map(async (u) => {
        try {
            fetched.set(u, await fetchText(u));
        }
        catch {
            // sem rede ou CDN em baixo: fica o original, a app avisa que precisa de internet
        }
    }));
    let out = html.replace(SCRIPT_TAG, (m, attrs, body) => {
        const u = remoteScriptSrc(attrs, body);
        const code = u ? fetched.get(u) : undefined;
        if (!u || code === undefined)
            return m;
        return `<script${cleanScriptAttrs(attrs)} data-inlined-from="${escapeAttr(u)}">\n${escapeScriptBody(code)}\n</script>`;
    });
    out = out.replace(LINK_TAG, (tag) => {
        const u = remoteStylesheetHref(tag);
        const css = u ? fetched.get(u) : undefined;
        if (!u || css === undefined)
            return tag;
        const media = attr(tag, 'media');
        const body = absolutizeCssUrls(css, u).replace(/<\/style/gi, '<\\/style');
        return `<style${media ? ` media="${escapeAttr(media)}"` : ''} data-inlined-from="${escapeAttr(u)}">\n${body}\n</style>`;
    });
    return out;
}
export async function prepareHtml(raw) {
    let html = ensureDocument(stripFences(raw));
    const tags = [];
    if (!/<meta[^>]+charset/i.test(html))
        tags.push('<meta charset="utf-8">');
    if (!/<meta[^>]+name\s*=\s*["']?viewport/i.test(html)) {
        tags.push('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    }
    html = injectIntoHead(html, tags.join('\n'));
    try {
        html = await inlineExternal(html);
    }
    catch {
        // nunca bloquear a importação por causa disto
    }
    return { html, externals: countExternal(html) };
}
export async function makeOffline(html) {
    const out = await inlineExternal(html);
    return { html: out, externals: countExternal(out) };
}
