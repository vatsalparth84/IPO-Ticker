// IPO Ticker - live IPO list sync.
// Reads IPO Ji (main source) and IPO Premium (best effort) and writes ipos.json.
// Needs Node 18+ (built-in fetch). No npm packages.   Run:  node scripts/sync.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "ipos.json");
const DET_DIR = join(ROOT, "details");
const MAX_DETAIL_FETCHES = 45;
const UA = "Mozilla/5.0 (compatible; IPOTickerSync/1.0; personal use)";
const IPOJI = "https://www.ipoji.com";
const LISTS = [
  { u: IPOJI + "/ipo/current-ipo", type: "Mainboard" },
  { u: IPOJI + "/sme-ipo/current-ipo", type: "SME" },
  { u: IPOJI + "/ipo/upcoming-ipo", type: "Mainboard" },
  { u: IPOJI + "/sme-ipo/upcoming-ipo", type: "SME" },
];
const KEEP_DAYS = 30; // drop IPOs that closed more than this many days ago
const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.SYNC_FAST ? 0 : ms)); // SYNC_FAST is for tests only

/* ---------- small helpers (no HTML library: works on text, not on CSS classes) ---------- */
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const decode = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&rupee;/g, "₹")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const toText = (h) =>
  decode(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp("(?<![\\w-])" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i"));
  return m ? decode(m[1] ?? m[2]) : null;
};
const absUrl = (u, base = IPOJI) =>
  !u ? null : /^https?:\/\//i.test(u) ? u : u.startsWith("//") ? "https:" + u : u.startsWith("/") ? base + u : null;
const isoDate = (mon, d, y) => {
  const m = MON[String(mon).slice(0, 3).toLowerCase()];
  return m ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
};
const num = (s) => parseFloat(String(s).replace(/,/g, ""));
export const norm = (n) =>
  String(n).toLowerCase().replace(/&/g, "").replace(/\b(limited|ltd|private|pvt|india|ipo)\b/g, "").replace(/[^a-z0-9]/g, "");
const slugify = (n) => String(n).toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined || o[k] === "") delete o[k]; return o; };

/* ---------- IPO Ji list page -> IPO cards ----------
   Every card starts with a company logo <img alt="<Name> - IPO company logo">. We cut the page at
   those images and read each piece as plain text, so CSS class names do not matter. */
export function parseIpoJi(html, def = { type: "Mainboard" }) {
  html = html.replace(/<!--[\s\S]*?-->|<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const marks = [];
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html))) {
    const alt = attr(m[0], "alt") || "";
    if (/IPO company logo\s*$/i.test(alt)) marks.push({ at: m.index, tag: m[0], alt });
  }
  const out = [];
  marks.forEach((mk, k) => {
    let chunk = html.slice(mk.at + mk.tag.length, k + 1 < marks.length ? marks[k + 1].at : html.length);
    const name = mk.alt.replace(/\s*-\s*IPO company logo\s*$/i, "").trim();
    if (!name) return;

    // the "View ... IPO" link gives the slug + page URL, and marks the end of this card
    let slug = null, url = null;
    const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']*\/(?:ipo|sme-ipo)\/([a-z0-9][a-z0-9-]*?)-ipo)(?:[?#][^"']*)?["'][^>]*>/gi;
    let lm;
    while ((lm = linkRe.exec(chunk))) {
      if (["current", "upcoming", "listed", "apply"].includes(lm[2])) continue;
      slug = lm[2]; url = absUrl(decode(lm[1]));
      const close = chunk.indexOf("</a>", lm.index);
      if (close > -1) chunk = chunk.slice(0, close + 4);
      break;
    }

    // logo: lazy-load attributes first, then src; skip inline placeholders and the site's generic image
    let logo = null;
    for (const a of ["data-src", "data-lazy-src", "data-original", "src"]) {
      const v = attr(mk.tag, a);
      if (v && !v.startsWith("data:")) { logo = absUrl(v); break; }
    }
    if (logo && /\/images\/ipo\.png(\?|$)/i.test(logo)) logo = null;

    const t = toText(chunk);
    const head = t.split(/Offer Price/i)[0].replace(name, " ");
    const dm = t.match(/([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\s*[–—-]\s*([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/);
    const open = dm ? isoDate(dm[1], dm[2], dm[3]) : null;
    const close = dm ? isoDate(dm[4], dm[5], dm[6]) : null;

    const type = /\bSME\b/i.test(head) ? "SME" : def.type;
    let ex = null;
    const em = head.match(/\b(NSE Emerge|NSE SME|BSE SME|BSE\s*[,·&]\s*NSE|NSE\s*[,·&]\s*BSE|NSE|BSE)\b/i);
    if (em) ex = /[,·&]/.test(em[1]) ? "NSE · BSE" : em[1].replace(/\s+/g, " ");
    if (!ex) ex = type === "SME" ? "SME" : "NSE · BSE";

    const pm = t.match(/Offer Price\s*₹?\s*([\d,]+(?:\.\d+)?)(?:\s*[-–—]\s*₹?\s*([\d,]+(?:\.\d+)?))?/i);
    let lo = null, hi = null;
    if (pm) { const a = num(pm[1]), b = pm[2] ? num(pm[2]) : a; lo = Math.min(a, b); hi = Math.max(a, b); }
    const lm2 = t.match(/Lot Size\s*([\d,]+)/i);
    const sm = t.match(/Issue Size\s*(.+?)(?:\s+(?:Exp\.?\s*Premium|Expected Premium|Subscription|View\b)|$)/i);
    const size = sm ? sm[1].replace(/\s*\(?agg\.? up to ₹\[\.\]\s*Cr\)?/i, "").trim().slice(0, 90) : null;

    out.push(clean({
      id: slug || slugify(name), name, type, ex, lo, hi, lot: lm2 ? num(lm2[1]) : null,
      open, close, logo, url, size,
      tent: /Expected Dates/i.test(head) || null,
      src: "ipoji",
    }));
  });
  return out;
}

/* ---------- network ---------- */
async function get(url, tries = 2) {
  let err = "unknown error";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-IN,en;q=0.9" },
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) return await r.text();
      err = "HTTP " + r.status;
      if (r.status === 403 || r.status === 429 || r.status === 503) break; // do not hammer a site that says no
    } catch (e) { err = e.message || String(e); }
    await sleep(1500);
  }
  throw new Error(err);
}

export async function scrapeIpoJi() {
  const items = new Map(), errors = [];
  for (const L of LISTS) {
    for (let p = 0; p < 6; p++) {
      const url = p ? `${L.u}?page=${p}` : L.u;
      let html;
      try { html = await get(url); }
      catch (e) { if (p === 0) errors.push(`${url}: ${e.message}`); break; } // a missing later page just means "no more pages"
      let added = 0;
      for (const c of parseIpoJi(html, L)) if (!items.has(c.id)) { items.set(c.id, c); added++; }
      if (!added) break;
      await sleep(800);
    }
    await sleep(800);
  }
  return { items: [...items.values()], errors };
}

/* ---------- IPO Premium (best effort) ----------
   ipopremium.in sits behind bot protection and builds its table with JavaScript, so this may be
   blocked or find nothing. It never breaks the sync: the result is reported in "sources". */
export async function scrapeIpoPremium(knownNorms) {
  const base = "https://www.ipopremium.in";
  let html;
  try { html = await get(base + "/", 1); } catch (e) { return { items: [], error: e.message }; }
  if (/just a moment|cf-chl|captcha|attention required|access denied/i.test(html.slice(0, 6000)))
    return { items: [], error: "blocked by bot protection" };
  const found = new Map();
  for (const m of html.matchAll(/\/view\/ipo\/(\d+)\/([a-z0-9-]+)/gi)) if (!found.has(m[1])) found.set(m[1], m[2]);
  if (!found.size) return { items: [], error: "no IPO links in page (loaded by JavaScript)" };
  const known = [...knownNorms];
  const isKnown = (k) => known.some((x) => x === k || (k.length >= 8 && x.length >= 8 && (x.startsWith(k) || k.startsWith(x))));
  const items = [];
  for (const [id, slug] of [...found].slice(0, 60)) {
    const nm = slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    if (isKnown(norm(nm))) continue;
    if (items.length >= 12) break;
    const url = `${base}/view/ipo/${id}/${slug}`;
    const it = { id: "ip-" + slug, name: nm, type: "Mainboard", ex: "NSE · BSE", url, src: "ipopremium" };
    try {
      await sleep(800);
      const t = toText(await get(url, 1));
      const h1 = t.match(/^(.*?)\s*\((Mainboard|SME)\)\s*IPO\b/i);
      if (h1 && h1[2].toUpperCase() === "SME") { it.type = "SME"; it.ex = "SME"; }
      const pm = t.match(/Price Band\s*₹\s*([\d,.]+)(?:\s*[–-]\s*₹?\s*([\d,.]+))?/i);
      if (pm) { const a = num(pm[1]), b = pm[2] ? num(pm[2]) : a; it.lo = Math.min(a, b); it.hi = Math.max(a, b); }
      const lt = t.match(/Lot Size\s*([\d,]+)\s*shares/i);
      if (lt) it.lot = num(lt[1]);
    } catch { /* keep the basic entry */ }
    items.push(clean(it));
  }
  return { items };
}

/* ---------- IPO Ji detail page -> structured sections ----------
   Works on text, not CSS classes: the page is turned into headings / paragraphs / tables / lists,
   then label+value pairs ("Lot size" + "600 shares") are recognised from IPO Ji's known labels. */
const LABELS = ["IPO Dates","Price band","Minimum Investment","Issue size","Lot size","Allotment Date","Listing","Listing At","Listing date","GMP","GMP percentage","Upper price band","Indicative listing price","Issue price","Face value","Total issue size","Fresh issue","Offer for sale (OFS)","Offer for sale","Retail Portion","QIB Portion","NII Portion","Employee Portion","Registrar","Lead manager","Lead managers","Book running lead manager","Shareholder Quota","Pre-Issue Holding","Post-Issue Holding","Market Maker","Market Maker Portion","Pre-issue shares","Issue type","ISIN","Employee discount"];
const LB = [...LABELS].sort((a, b) => b.length - a.length).map((l) => [l, l.toLowerCase()]);
const MULTI = new Set(["total issue size", "fresh issue", "offer for sale (ofs)", "offer for sale", "shareholder quota"]);
const HINT = /^([A-Za-z][A-Za-z\/ .&%()-]{1,28}?)\s*\(((?:[^()]|\([^()]*\)){12,})\)\s*(.{0,30})$/;
const NOISE = /^(Apply( for .*)?|Read more|Loading\.\.\.|Click any question.*|Scan to get.*|Google Play|App Store|Skip to .*|Track live subscription.*|View the full .*|Your browser cannot display.*|● .*|.* IPO logo|Login.*|Log Out)$/i;
const INL = /<\/?(?:span|b|strong|i|em|a|small|sup|sub|u|mark|abbr|time|font|code)\b[^>]*>/gi;
const tidy = (s) => s.replace(/\u0004\s*(?=\()/g, " ").replace(/\u0004/g, " · ").replace(/\s+/g, " ").replace(/₹\s+(?=\d)/g, "₹")
  .replace(/\s+([,.;:)])/g, "$1").replace(/\(\s+/g, "(").replace(/^[ ·]+|[ ·]+$/g, "").trim();
const lines = (h) => decode(h.replace(INL, " ").replace(/<br\s*\/?>/gi, "\u0004").replace(/<img\b[^>]*>/gi, " ").replace(/<[^>]+>/g, "\n"))
  .split("\n").map(tidy).filter(Boolean);
const cell = (h) => lines(h.replace(/<br\s*\/?>/gi, " / ")).join(" ").replace(/\*\*/g, "");
function parseTable(m) {
  const rows = [...m.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) => ({ th: /<th\b/i.test(r[0]), c: [...r[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => cell(c[1])) })).filter((r) => r.c.length);
  if (!rows.length) return null;
  const head = rows[0].th ? rows[0].c : null;
  return { head, rows: (head ? rows.slice(1) : rows).slice(0, 40).map((r) => r.c) };
}
function splitLabel(p) {
  const t = p.replace(/:\s*$/, "").trim(), low = t.toLowerCase();
  for (const [L, l] of LB) {
    if (low === l) return { label: L, value: null };
    if (t.length <= 120 && low.startsWith(l) && /^[\s:]/.test(t.slice(l.length))) {
      const v = t.slice(l.length).replace(/^[\s:]+/, ""); if (v && !/^[a-z]/.test(v)) return { label: L, value: v }; // "Lot size of 110…" is a sentence, not a label
    }
  }
  const m = p.match(HINT);
  return m ? { label: m[1].trim(), hint: m[2].trim(), value: m[3] ? m[3].trim() : null } : null;
}
const stripMore = (s) => s.replace(/\s*Read more\s*$/i, "").trim();
function groupKv(blocks) {
  const out = []; let i = 0;
  const push = (kv) => { const last = out[out.length - 1]; if (last && last.kv) last.kv.push(kv); else out.push({ kv: [kv] }); };
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.p) {
      const sl = splitLabel(b.p);
      if (sl) {
        let v = sl.value, j = i + 1;
        if (v == null) {
          const n = blocks[j];
          if (n && n.p && !splitLabel(n.p) && n.p.length <= 160) { v = n.p; j++; }
          if (v != null) {
            const multi = MULTI.has(sl.label.toLowerCase());
            while (blocks[j] && blocks[j].p && !splitLabel(blocks[j].p) && (/^\(/.test(blocks[j].p) || (multi && blocks[j].p.length < 80)) && j < i + 4) { v += " · " + blocks[j].p; j++; }
          }
        }
        if (v != null && v !== "") { push(clean({ 0: sl.label, 1: stripMore(v).replace(/ · \(/g, " ("), 2: sl.hint })); i = j; continue; }
        i++; continue; // a label with no value (e.g. a caption) is dropped
      }
      const m = b.p.match(/^(.{3,70}?)\s+(\d[\d,]*(?:\.\d+)?\s?x)$/i);
      if (m) { push({ 0: m[1], 1: m[2].replace(/\s/g, "") }); i++; continue; }
    }
    out.push(b); i++;
  }
  return out.map((b) => (b.kv ? { kv: b.kv.map((o) => [o[0], o[1], ...(o[2] ? [o[2]] : [])]) } : b));
}
export function parseDetail(html) {
  html = html.replace(/<!--[\s\S]*?-->|<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const h1 = html.search(/<h1\b/i); if (h1 < 0) return null; html = html.slice(h1);
  const docs = [];
  html = html.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => {
    const x = lines(t).join(" ");
    if (!/^(DRHP|RHP|ANCHOR|Prospectus|Abridged Prospectus|Addendum)\b/i.test(x)) return m;
    const u = absUrl(decode(href)); if (u && !docs.some((d) => d[0] === x)) docs.push([x, u]); return " ";
  });
  html = html.replace(/<a\b[^>]*href\s*=\s*["'](?:#|[^"']*(?:\/blog\/|\/apply-ipo\/|\/download|play\.google\.com|apps\.apple\.com|\?sh=true))[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, " ");
  const tables = [], lists = [];
  html = html.replace(/<table\b[\s\S]*?<\/table>/gi, (m) => { tables.push(parseTable(m)); return `\n\u0001T${tables.length - 1}\u0001\n`; });
  html = html.replace(/<(ol|ul)\b[\s\S]*?<\/\1>/gi, (m) => { lists.push([...m.matchAll(/<li\b[\s\S]*?<\/li>/gi)].map((li) => lines(li[0].replace(/^<li\b[^>]*>|<\/li>$/gi, "")))); return `\n\u0001L${lists.length - 1}\u0001\n`; });
  html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, l, t) => `\n\u0002H${l}|${lines(t).join(" ")}\u0002\n`);
  let blocks = [];
  for (const ln of lines(html)) {
    let m;
    if ((m = ln.match(/^\u0001T(\d+)\u0001$/))) { if (tables[+m[1]]) blocks.push({ t: tables[+m[1]] }); }
    else if ((m = ln.match(/^\u0001L(\d+)\u0001$/))) { if (lists[+m[1]].length) blocks.push({ ol: lists[+m[1]] }); }
    else if ((m = ln.match(/^\u0002H(\d)\|(.*)\u0002$/))) blocks.push({ h: m[2], l: +m[1] });
    else blocks.push({ p: ln.slice(0, 2000) });
  }
  const end = blocks.findIndex((b) => (b.p && /^Get in Touch$/.test(b.p)) || (b.h && /Step into IPO Spotlight|Welcome to IPO Ji/i.test(b.h)));
  if (end > -1) blocks = blocks.slice(0, end);
  const title = (blocks.find((b) => b.h && b.l === 1) || {}).h || "";
  let upd = null, summary = null;
  const secs = []; let cur = null;
  for (const b of blocks) {
    if (b.h && b.l <= 2) { cur = { h: b.l === 1 ? "Overview" : b.h, b: [] }; secs.push(cur); continue; }
    if (!cur) { cur = { h: "Overview", b: [] }; secs.push(cur); }
    if (b.p) {
      const u = b.p.match(/^Updated (.+)$/); if (u && !upd) { upd = u[1]; continue; }
      if (NOISE.test(b.p)) continue;
    }
    cur.b.push(b.h ? { h3: b.h } : b);
  }
  const out = [];
  secs.forEach((s, k) => {
    if (/FAQ/i.test(s.h)) return;
    let bl = s.b.map((x) => (x.p === "•" ? { bul: true } : x.p && /^[•▪]\s+/.test(x.p) ? { ul: [x.p.replace(/^[•▪]\s+/, "")] } : x));
    bl = bl.reduce((a, x, i) => { if (x.p && bl[i - 1] && bl[i - 1].bul) a.push({ ul: [x.p] }); else if (!x.bul) a.push(x); return a; }, []);
    bl = bl.reduce((a, x) => { const l = a[a.length - 1]; if (x.ul && l && l.ul) l.ul.push(...x.ul); else a.push(x); return a; }, []);
    bl = groupKv(bl).filter((x) => !(x.h3 && /Documents$/i.test(x.h3))); // links are shown in their own card
    if (k === 0) {
      const i0 = bl.findIndex((x) => x.p); if (i0 > -1) summary = bl[i0].p;
      // header widgets (name line, badges, "Apply") sit before the first fact/table/list: drop those paragraphs
      const first = bl.findIndex((x) => !x.p);
      bl = bl.filter((x, i) => !x.p || (first > -1 && i > first));
    }
    let sub = "";
    bl = bl.map((x) => { if (x.h3) sub = x.h3; if (x.p && /^(Strengths|Risks)$/i.test(sub) && /^[^:]{6,100}:\s/.test(x.p)) return { p: x.p, lead: 1 }; return x; });
    if (bl.length) out.push({ h: s.h, b: bl });
  });
  if (!out.length) return null;
  const kvs = out.flatMap((s) => s.b.filter((x) => x.kv).flatMap((x) => x.kv));
  const g = kvs.find((x) => /^GMP$/i.test(x[0])), gp = kvs.find((x) => /^GMP percentage$/i.test(x[0]));
  const tot = kvs.find((x) => /^Total$/i.test(x[0]) && /x$/i.test(x[1]));
  return clean({ v: 1, title, summary, upd, gmp: g ? g[1] + (gp ? ` (${gp[1]})` : "") : null, sub: tot ? tot[1] : null, sections: out.slice(0, 30), docs: docs.length ? docs : null });
}

/* ---------- detail pages: details/<id>.json ----------
   Open IPOs are re-read on every run, IPOs with dates hourly, the rest every 6 hours (to keep requests low). */
export async function scrapeDetails(items, dir = DET_DIR, now = new Date()) {
  const today = new Date(+now + 5.5 * 3600e3).toISOString().slice(0, 10), firstHalf = now.getUTCMinutes() < 30, slowSlot = firstHalf && now.getUTCHours() % 6 === 0;
  const out = new Map(), errs = []; let n = 0;
  for (const it of items) {
    if (it.src !== "ipoji" || !it.url) continue;
    const hot = it.open && it.open <= today && (it.close || it.open) >= today;
    if (existsSync(join(dir, it.id + ".json")) && !hot && !(it.open ? firstHalf : slowSlot)) continue;
    if (n++ >= MAX_DETAIL_FETCHES) break;
    try {
      const d = parseDetail(await get(it.url, 1));
      if (d) { d.id = it.id; out.set(it.id, d); } else errs.push(`${it.id}: page had no recognisable content`);
    } catch (e) { errs.push(`${it.id}: ${e.message}`); }
    await sleep(800);
  }
  return { out, errs };
}
export async function syncDetails(items, dir = DET_DIR, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  const { out, errs } = await scrapeDetails(items, dir, now);
  let written = 0, removed = 0;
  for (const [id, d] of out) {
    const f = join(dir, id + ".json"), txt = JSON.stringify(d) + "\n";
    if (!existsSync(f) || readFileSync(f, "utf8") !== txt) { writeFileSync(f, txt); written++; }
  }
  const ids = new Set(items.map((i) => i.id));
  for (const f of readdirSync(dir)) if (f.endsWith(".json") && !ids.has(f.slice(0, -5))) { unlinkSync(join(dir, f)); removed++; }
  for (const it of items) {
    const f = join(dir, it.id + ".json");
    if (existsSync(f)) try { const d = JSON.parse(readFileSync(f, "utf8")); it.det = 1; if (d.gmp) it.gmp = d.gmp; if (d.sub) it.sub = d.sub; } catch { /* ignore a damaged file */ }
  }
  return { fetched: out.size, written, removed, errs };
}

/* ---------- build + write ---------- */
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const shiftDays = (iso, d) => new Date(Date.parse(iso + "T00:00:00Z") + d * 864e5).toISOString().slice(0, 10);

export function assemble(ipoji, prem) {
  const cutoff = shiftDays(todayIST(), -KEEP_DAYS);
  return [...ipoji, ...prem].filter((i) => !i.close || i.close >= cutoff);
}

async function main() {
  const ji = await scrapeIpoJi();
  if (ji.errors.length || !ji.items.length) {
    console.error("IPO Ji sync failed - keeping the previous ipos.json.\n" + (ji.errors.join("\n") || "No IPO cards were found (page layout may have changed)."));
    process.exit(1);
  }
  const pr = await scrapeIpoPremium(new Set(ji.items.map((i) => norm(i.name))));
  const ipos = assemble(ji.items, pr.items);
  const dt = await syncDetails(ipos);
  const body = {
    sources: {
      ipoji: { ok: true, count: ji.items.length },
      ipopremium: pr.error ? { ok: false, count: 0, error: pr.error } : { ok: true, count: pr.items.length },
    },
    ipos,
  };
  let prev = null;
  if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* ignore */ } }
  const same = prev && JSON.stringify({ sources: prev.sources, ipos: prev.ipos }) === JSON.stringify(body);
  console.log(`Details: ${dt.fetched} fetched, ${dt.written} changed, ${dt.removed} removed${dt.errs.length ? ", problems: " + dt.errs.join("; ") : ""}`);
  console.log(`IPO Ji: ${ji.items.length} IPOs | IPO Premium: ${pr.error ? "unavailable (" + pr.error + ")" : pr.items.length + " extra"} | in file: ${ipos.length}`);
  if (same) { console.log("ipos.json unchanged."); return; }
  writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), ...body }, null, 1) + "\n");
  console.log("ipos.json updated.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
