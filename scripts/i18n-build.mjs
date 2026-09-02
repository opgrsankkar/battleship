#!/usr/bin/env node
// Build localized pages from public/index.html (English base) + i18n/<locale>.json.
// Emits public/<locale>/index.html, injects hreflang + a language switcher into
// every page, and regenerates public/sitemap.xml with hreflang alternates.
// Deterministic string replacement only — never rewrites markup/IDs/scripts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(join(ROOT, 'i18n/en.json'), 'utf8'));
const ORIGIN = en._meta.origin;
const LOCALES = en._meta.locales; // ['en','es',...]
const HREFLANG = { en: 'en', 'pt-br': 'pt-BR', es: 'es', fr: 'fr', de: 'de', vi: 'vi', th: 'th' };
const SWITCH_LABEL = { en: 'EN', es: 'ES', 'pt-br': 'PT', fr: 'FR', de: 'DE', vi: 'VI', th: 'TH' };
const localeUrl = (l) => (l === 'en' ? `${ORIGIN}/` : `${ORIGIN}/${l}/`);

let warnings = 0;
const litReplace = (s, from, to, ctx) => {
  if (!s.includes(from)) { console.warn(`  ⚠ anchor not found (${ctx}): ${JSON.stringify(from).slice(0, 60)}`); warnings++; return s; }
  return s.split(from).join(to);
};
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- clean base: strip any previously-injected i18n blocks ----
let base = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
base = base.replace(/\s*<!-- i18n:hreflang:start -->[\s\S]*?<!-- i18n:hreflang:end -->/g, '');
base = base.replace(/\s*<!-- i18n:switcher:start -->[\s\S]*?<!-- i18n:switcher:end -->/g, '');
base = base.replace(/\s*<!-- i18n:runtime:start -->[\s\S]*?<!-- i18n:runtime:end -->/g, '');
base = base.replace(/\s*<!-- i18n:room-redirect:start -->[\s\S]*?<!-- i18n:room-redirect:end -->/g, '');

// ---- shared fragments ----
const hreflangBlock = () => {
  const links = LOCALES.map((l) => `  <link rel="alternate" hreflang="${HREFLANG[l]}" href="${localeUrl(l)}" />`);
  links.push(`  <link rel="alternate" hreflang="x-default" href="${ORIGIN}/" />`);
  return `\n  <!-- i18n:hreflang:start -->\n${links.join('\n')}\n  <!-- i18n:hreflang:end -->`;
};
const switcher = (cur) => {
  const items = LOCALES.map((l) => {
    const active = l === cur;
    const style = active
      ? 'color:#fff;font-weight:700;text-decoration:none;'
      : 'color:#9fb6d0;text-decoration:none;';
    return `<a href="${l === 'en' ? '/' : '/' + l + '/'}" hreflang="${HREFLANG[l]}"${active ? ' aria-current="true"' : ''} style="${style}">${SWITCH_LABEL[l]}</a>`;
  });
  return `\n<!-- i18n:switcher:start -->\n<nav aria-label="Language" style="position:fixed;top:8px;right:10px;z-index:300;font-size:12px;font-family:system-ui,-apple-system,sans-serif;background:rgba(10,22,40,.9);border:1px solid #1e4070;border-radius:999px;padding:5px 12px;display:flex;gap:9px;box-shadow:0 2px 10px rgba(0,0,0,.35);">\n  ${items.join('\n  ')}\n</nav>\n<!-- i18n:switcher:end -->`;
};

// build the localized SEO content <section> from a locale's seo object
const seoSection = (s) => {
  const steps = s.howToSteps.map((x) => `        <li>${esc(x)}</li>`).join('\n');
  const feats = s.features.map((x) => `        <li>${esc(x)}</li>`).join('\n');
  const faqs = s.faqs.map((f) => `        <h4>${esc(f.q)}</h4>\n        <p>${esc(f.a)}</p>`).join('\n');
  return `<section class="seo-content">
    <div class="seo-inner">
      <h2>${esc(s.h2)}</h2>
      <p>${esc(s.intro)}</p>
      <h3 class="seo-h">${esc(s.howToTitle)}</h3>
      <ol class="seo-list">
${steps}
      </ol>
      <h3 class="seo-h">${esc(s.featuresTitle)}</h3>
      <ul class="seo-list">
${feats}
      </ul>
      <h3 class="seo-h">${esc(s.faqTitle)}</h3>
      <div class="seo-faq">
${faqs}
      </div>
      <p class="seo-cta"><a href="#" onclick="showScreen('screen-menu');window.scrollTo({top:0,behavior:'smooth'});return false;">${esc(s.cta)}</a></p>
    </div>
  </section>`;
};

// localized FAQPage JSON-LD
const faqJsonLd = (s) => {
  const entities = s.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }));
  const obj = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: entities };
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n  </script>`;
};

// Per-player rooms: a shared /?room=CODE link is locale-less. This early script
// redirects the joiner to their OWN locale page (/<loc>/?room=CODE) based on
// hk_lang (set on any page they've browsed) with a navigator.language fallback —
// so two players in different languages each see the game in their own language.
// It also records this page's locale as hk_lang for future visits. Guarded so the
// correct-locale page never redirects again (no loop).
const roomRedirect = (cur) =>
  `\n  <!-- i18n:room-redirect:start -->\n  <script>\n  (function(){var L=${JSON.stringify(cur)},A=${JSON.stringify(LOCALES)};try{var p=new URLSearchParams(location.search);if(p.get('room')){var w='';try{w=localStorage.getItem('hk_lang')||'';}catch(e){}if(A.indexOf(w)<0){var n=(navigator.language||'en').toLowerCase();w=n.indexOf('pt')===0?'pt-br':(A.indexOf(n.slice(0,2))>=0?n.slice(0,2):'en');}if(w!==L){location.replace((w==='en'?'/':'/'+w+'/')+location.search+location.hash);return;}}try{localStorage.setItem('hk_lang',L);}catch(e){}}catch(e){}})();\n  </script>\n  <!-- i18n:room-redirect:end -->`;

const injectHead = (html, cur) =>
  html.replace('<head>', `<head>${roomRedirect(cur)}`)
      .replace('</head>', `${hreflangBlock()}\n</head>`)
      .replace(/(<body[^>]*>)/, `$1${switcher(cur)}`);

// inject the runtime string dictionary + a tiny t() helper before game.js so
// game.js can localize strings it renders at play-time (turn/win/lose/log text)
const injectRuntime = (html, runtime) => {
  const block = `<!-- i18n:runtime:start -->\n<script>\nwindow.__I18N__ = ${JSON.stringify(runtime)};\nwindow.t = function(k, p){ var d = window.__I18N__ || {}; var s = String(k).split('.').reduce(function(o,i){return (o==null)?undefined:o[i];}, d); if (s == null) s = k; if (p) for (var n in p) s = s.split('{'+n+'}').join(p[n]); return s; };\n</script>\n<!-- i18n:runtime:end -->\n  `;
  return html.replace(/(<script src="\/?game\.js"><\/script>)/, `${block}$1`);
};

// ---- English page: inject hreflang + switcher only, keep everything else ----
{
  let html = injectRuntime(injectHead(base, 'en'), en.runtime);
  writeFileSync(join(ROOT, 'public/index.html'), html);
  console.log('en  -> public/index.html');
}

// ---- localized pages ----
for (const loc of LOCALES.filter((l) => l !== 'en')) {
  const t = JSON.parse(readFileSync(join(ROOT, `i18n/${loc}.json`), 'utf8'));
  let html = base;

  // html lang
  html = html.replace(/<html lang="en">/, `<html lang="${loc}">`);
  // head strings
  html = litReplace(html, `<title>${en.title}</title>`, `<title>${t.title}</title>`, 'title');
  html = litReplace(html, en.description, t.description, 'description');            // meta+og+twitter
  html = litReplace(html, en.ogTitle, t.ogTitle, 'ogTitle');                       // og+twitter title
  html = litReplace(html, `href="${ORIGIN}/"`, `href="${ORIGIN}/${loc}/"`, 'canonical');
  // localized FAQPage JSON-LD
  html = html.replace(/<script type="application\/ld\+json">\s*\{\s*"@context":\s*"https:\/\/schema\.org",\s*"@type":\s*"FAQPage"[\s\S]*?<\/script>/, faqJsonLd(t.seo));

  html = litReplace(html, `<h1>${en.logoTitle}</h1>`, `<h1>${t.logoTitle}</h1>`, 'logoTitle');
  // hint paragraphs FIRST — they contain inline <strong>Rotate (R)</strong> /
  // <strong>Ready!</strong> whose anchors would otherwise be rewritten by the
  // label loop below, breaking these regex end-anchors.
  html = html.replace(/Easy: random shots[\s\S]*?Hard: probability-based/, esc(t.ui.difficultyHint));
  html = html.replace(/(?:Select a ship from the list|Drag ships onto the grid)[\s\S]*?Ready!<\/strong>/, esc(t.ui.placeShipsHint));
  // logo + UI text labels (anchored as element text)
  const textKeys = ['vsComputer','multiplayer','createRoom','join','back','copyCode','copyLink','difficulty','easy','medium','hard','placeShips','rotate','random','ready','yourFleet','enemyWaters','you','opponent','playAgain','mainMenu','leaderboard','quickMatch','privateRoom','cancel','findNewOpponent'];
  for (const k of textKeys) html = litReplace(html, `>${en.ui[k]}<`, `>${t.ui[k]}<`, `ui.${k}`);
  html = litReplace(html, `>${en.ui.waiting}<`, `>${t.ui.waiting}<`, 'ui.waiting');
  // placeholders
  html = litReplace(html, `placeholder="${en.ui.nickname}"`, `placeholder="${t.ui.nickname}"`, 'ui.nickname');
  html = litReplace(html, `placeholder="${en.ui.roomCode}"`, `placeholder="${t.ui.roomCode}"`, 'ui.roomCode');
  // footer
  html = litReplace(html, `>Built by <`, `>${t.footer.builtBy} <`, 'footer.builtBy');
  html = litReplace(html, `>${en.footer.allGames}<`, `>${t.footer.allGames}<`, 'footer.allGames');
  html = litReplace(html, `>${en.footer.sourceCode}<`, `>${t.footer.sourceCode}<`, 'footer.sourceCode');
  html = litReplace(html, `>${en.footer.coffee}<`, `>${t.footer.coffee}<`, 'footer.coffee');

  // localized visible SEO section
  html = html.replace(/<section class="seo-content">[\s\S]*?<\/section>/, seoSection(t.seo));

  // subdirectory: make relative asset paths absolute so /<loc>/ resolves them
  html = html.replace(/href="style\.css"/g, 'href="/style.css"')
             .replace(/src="name\.js"/g, 'src="/name.js"')
             .replace(/src="placement\.js"/g, 'src="/placement.js"')
             .replace(/src="game\.js"/g, 'src="/game.js"');

  html = injectRuntime(injectHead(html, loc), t.runtime);
  mkdirSync(join(ROOT, `public/${loc}`), { recursive: true });
  writeFileSync(join(ROOT, `public/${loc}/index.html`), html);
  console.log(`${loc.padEnd(3)} -> public/${loc}/index.html`);
}

// ---- sitemap with hreflang alternates ----
const XHTML = 'xmlns:xhtml="http://www.w3.org/1999/xhtml"';
const today = new Date().toISOString().slice(0, 10);
const alts = LOCALES.map((l) => `    <xhtml:link rel="alternate" hreflang="${HREFLANG[l]}" href="${localeUrl(l)}"/>`).join('\n')
  + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/"/>`;
const urls = LOCALES.map((l) => `  <url>
    <loc>${localeUrl(l)}</loc>
    <lastmod>${today}</lastmod>
${alts}
  </url>`).join('\n');
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ${XHTML}>
${urls}
</urlset>
`;
writeFileSync(join(ROOT, 'public/sitemap.xml'), sitemap);
console.log('sitemap -> public/sitemap.xml');
console.log(warnings ? `\nDone with ${warnings} anchor warning(s) — check above.` : '\nDone. All anchors matched.');
