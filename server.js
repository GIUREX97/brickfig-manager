import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Compressione gzip/brotli per tutte le risposte >1KB
app.use(compression({ threshold: 1024, level: 6, filter: (req,res)=>{ if(req.headers['x-no-compression']) return false; return compression.filter(req,res); } }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
// Cache headers per asset statici: 1 anno per asset con hash, 1 giorno per html
app.use(express.static(__dirname, {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) { res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'); }
    else if (p.endsWith('.css') || p.endsWith('.js')) { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); }
    else if (p.includes('/data/')) { res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate'); }
  }
}));

// Cache in memoria per velocità
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 ore
// FIX 13-09-2026: protezione anti-resurrect RIMOSSA (causava perdita inserzioni locali dopo 2min) - mantenuta variabile per compat ma non usata
let resetProtectionUntil = 0;

function normalizeCode(input) {
  return input.trim().toLowerCase().replace(/\s+/g, '');
}

function detectType(code) {
  code = normalizeCode(code);
  if (code.replace(/[\s\-_]+/g,'').startsWith('sfuso')) return 'P';
  // Se è formato colXX-YY (es. col03-9) è Set completo CMF con stand/accessori, non Minifigure singola
  if (/^col\d+[-_]\d+/.test(code)) return 'S';
  if (/^\d/.test(code)) return 'P';
  return 'M';
}

function getCodeVariants(input) {
  input = normalizeCode(input);
  let variants = [input];
  // Solo per Minifigure (M) mappiamo col03-9 -> col041, per Set (S) teniamo col03-9 così com'è
  const isSet = /^col\d+[-_]\d+/.test(input);
  if (!isSet) {
    let m = input.match(/^col0*(\d+)[-_\.]0*(\d+)$/);
    if (m) {
      let series = parseInt(m[1], 10);
      let num = parseInt(m[2], 10);
      let global = (series - 1) * 16 + num;
      let padded = 'col' + String(global).padStart(3, '0');
      if (!variants.includes(padded)) variants.push(padded);
    }
  }
  let m2 = input.match(/^([a-z]+)(\d+)(.*)$/);
  if (m2) {
    let prefix = m2[1];
    let num = m2[2];
    let suffix = m2[3] || '';
    if (!input.includes('-') && num.length < 4) {
      let padded4 = prefix + num.padStart(4, '0') + suffix;
      if (!variants.includes(padded4)) variants.push(padded4);
    }
  }
  if (input.includes('-') || input.includes('_')) {
    let noHyphen = input.replace(/[-_]/g, '');
    if (!variants.includes(noHyphen)) variants.push(noHyphen);
  }
  // Fix parti con suffisso variante lettera: 3069b -> 3069, 3040b -> 3040, 3005a -> 3005
  // BrickLink ha unificato molte varianti "b" nella base senza lettera
  if (/^\d+[a-z]+$/i.test(input)) {
    let base = input.replace(/[a-z]+$/i, '');
    if (base && /^\d+$/.test(base) && !variants.includes(base)) variants.push(base);
  }
  // Caso 3069bpb01 / 3040bpb001 -> rimuovi la lettera variante prima di pb/c
  const mLetterPb = input.match(/^(\d+)[a-z](pb.*|c\d+.*)$/i);
  if (mLetterPb) {
    let alt = mLetterPb[1] + mLetterPb[2];
    if (!variants.includes(alt)) variants.push(alt);
    let base2 = mLetterPb[1];
    if (!variants.includes(base2) && /^\d+$/.test(base2)) variants.push(base2);
  }
  return [...new Set(variants)];
}

function bricklinkImageUrl(code, type) {
  code = normalizeCode(code);
  if (type === 'P') return `https://img.bricklink.com/ItemImage/PN/0/${code}.png`;
  if (type === 'S') return `https://img.bricklink.com/ItemImage/SN/0/${code}.png`;
  if (type === 'G') return `https://img.bricklink.com/ItemImage/GN/0/${code}.png`;
  return `https://img.bricklink.com/ItemImage/MN/0/${code}.png`;
}

function extractCategory($, html) {
  // Prova breadcrumb BrickLink: Catalog: Minifigures > Star Wars > ...
  const cats = [];
  $('a[href*="catalogList.asp?catType="]').each((i, el) => {
    const t = $(el).text().trim();
    if (t && t !== 'Catalog' && t !== 'Minifigures' && t !== 'Parts') cats.push(t);
  });
  // Fallback per parti: cerca Categorie parti
  if (cats.length === 0) {
    $('a[href*="catalogList.asp"]').each((i, el) => {
      const t = $(el).text().trim();
      if (t) cats.push(t);
    });
  }
  if (cats.length) {
    // Rimuovi duplicati e prendi gli ultimi 2-3 rilevanti
    const uniq = [...new Set(cats)];
    // Per minifig: spesso ["Collectible Minifigures", "Series 1 Minifigures"] o ["Star Wars", "Star Wars Episode 1"]
    // Per parti: ["Brick, Modified", "1 x 2 with Groove"]
    const full = uniq.join(' > ').replace(/\s+/g, ' ').trim();
    return { full, main: uniq[uniq.length - 1], primary: uniq[0] };
  }
  // Fallback da meta
  const catMeta = html.match(/catString=([^&"]+)/);
  if (catMeta) return { full: decodeURIComponent(catMeta[1]), main: decodeURIComponent(catMeta[1]), primary: decodeURIComponent(catMeta[1]) };
  return null;
}
function getMacroCategoria(full){
  if(!full) return 'Altro';
  const l=full.toLowerCase();
  if(l.startsWith('sfuso')) return 'Sfuso';
  if(l.startsWith('collectible minifigures')) return 'Collezionabili';
  if(l.startsWith('ninjago')) return 'Ninjago';
  if(l.startsWith('harry potter')) return 'Harry Potter';
  if(l.startsWith('star wars')) return 'Star Wars';
  if(l.startsWith('animal')) return 'Animali';
  if(l.startsWith('castle')) return 'Castle';
  if(l.startsWith('holiday')) return 'Holiday';
  if(l.startsWith('despicable me')) return 'Despicable Me';
  if(l.startsWith('vikings')) return 'Vikings';
  if(l.startsWith('road sign')) return 'Accessori';
  if(l.startsWith('minecraft')) return 'Minecraft';
  if(l.startsWith('adventurers')) return 'Adventurers';
  if(l.startsWith('indiana jones')) return 'Indiana Jones';
  if(l.startsWith('pirates')) return 'Pirati';
  if(l.startsWith('town') || l.startsWith('city')) return 'City';
  if(l.startsWith('space')) return 'Space';
  if(l.startsWith('disney')) return 'Disney';
  if(l.startsWith('marvel')) return 'Marvel';
  const first=full.split('>')[0].trim();
  return first || 'Altro';
}

// === CODICI INTERNI SFUSO AL KG (gestionale locale, non BrickLink) ===
// Mappatura codici interni -> dati sfuso. Accetta varianti con/senza trattino, maiuscole/minuscole.
const SFUSO_INTERNI = {
  'sfusomisto':               { nome: 'Sfuso Misto',                categoria: 'Sfuso > Misto - al Kg',              foto: 'https://img.bricklink.com/ItemImage/PN/0/3001.png',  colore: 'Misto' },
  'sfusotechnic':             { nome: 'Sfuso Technic',              categoria: 'Sfuso > Technic - al Kg',            foto: 'https://img.bricklink.com/ItemImage/PN/0/3701.png',  colore: 'Technic' },
  'sfusodarkbluishgrey':      { nome: 'Sfuso Dark Bluish Grey',     categoria: 'Sfuso > Dark Bluish Grey - al Kg',   foto: 'https://img.bricklink.com/ItemImage/PN/85/3001.png', colore: 'Dark Bluish Grey' },
  'sfusodbg':                 { nome: 'Sfuso Dark Bluish Grey',     categoria: 'Sfuso > Dark Bluish Grey - al Kg',   foto: 'https://img.bricklink.com/ItemImage/PN/85/3001.png', colore: 'Dark Bluish Grey' },
  'sfusolightbluishgrey':     { nome: 'Sfuso Light Bluish Grey',    categoria: 'Sfuso > Light Bluish Grey - al Kg',  foto: 'https://img.bricklink.com/ItemImage/PN/86/3001.png', colore: 'Light Bluish Grey' },
  'sfusolbg':                 { nome: 'Sfuso Light Bluish Grey',    categoria: 'Sfuso > Light Bluish Grey - al Kg',  foto: 'https://img.bricklink.com/ItemImage/PN/86/3001.png', colore: 'Light Bluish Grey' },
  'sfusotan':                 { nome: 'Sfuso Tan',                  categoria: 'Sfuso > Tan - al Kg',                foto: 'https://img.bricklink.com/ItemImage/PN/2/3001.png',  colore: 'Tan' },
  'sfusoreddishbrown':        { nome: 'Sfuso Reddish Brown',        categoria: 'Sfuso > Reddish Brown - al Kg',      foto: 'https://img.bricklink.com/ItemImage/PN/88/3001.png', colore: 'Reddish Brown' },
  'sfusorb':                  { nome: 'Sfuso Reddish Brown',        categoria: 'Sfuso > Reddish Brown - al Kg',      foto: 'https://img.bricklink.com/ItemImage/PN/88/3001.png', colore: 'Reddish Brown' },
  'sfusodarktan':             { nome: 'Sfuso Dark Tan',             categoria: 'Sfuso > Dark Tan - al Kg',           foto: 'https://img.bricklink.com/ItemImage/PN/69/3001.png', colore: 'Dark Tan' },
  'sfusodt':                  { nome: 'Sfuso Dark Tan',             categoria: 'Sfuso > Dark Tan - al Kg',           foto: 'https://img.bricklink.com/ItemImage/PN/69/3001.png', colore: 'Dark Tan' },
  'sfusopearlgold':           { nome: 'Sfuso Pearl Gold',           categoria: 'Sfuso > Pearl Gold - al Kg',         foto: 'https://img.bricklink.com/ItemImage/PN/115/3001.png',colore: 'Pearl Gold' },
  'sfusopg':                  { nome: 'Sfuso Pearl Gold',           categoria: 'Sfuso > Pearl Gold - al Kg',         foto: 'https://img.bricklink.com/ItemImage/PN/115/3001.png',colore: 'Pearl Gold' },
  'sfusopearlgold':           { nome: 'Sfuso Pearl Gold',           categoria: 'Sfuso > Pearl Gold - al Kg',         foto: 'https://img.bricklink.com/ItemImage/PN/115/3001.png',colore: 'Pearl Gold' },
  'sfusofig':                 { nome: 'Sfuso Fig',                  categoria: 'Sfuso > Fig - al Kg',                foto: 'https://img.bricklink.com/ItemImage/MN/0/973.png',     colore: 'Fig' },
  'sfusotile':                { nome: 'Sfuso Tile',                 categoria: 'Sfuso > Tile - al Kg',               foto: 'https://img.bricklink.com/ItemImage/PN/0/3069.png',  colore: 'Tile' },
};
function normalizeSfusoKey(input){
  return input.trim().toLowerCase().replace(/[\s\-_]+/g, '').replace(/[^a-z0-9]/g,'');
}
function getSfusoInterno(rawCode){
  const key = normalizeSfusoKey(rawCode);
  // accetta anche con prefisso sfuso- generico: sfuso-qualcosa -> cerca esatto o crea generico
  if (SFUSO_INTERNI[key]) return { key, data: SFUSO_INTERNI[key] };
  // se inizia con sfuso ma non in mappa, crea generico al volo
  if (key.startsWith('sfuso') && key.length>5){
    const suffix = rawCode.trim().replace(/^sfuso[\s\-_]*/i,'').trim() || key.slice(5);
    const nome = 'Sfuso ' + suffix.split(/[\s\-_]+/).map(w=> w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
    return { key, data: { nome: nome, categoria: 'Sfuso > '+suffix+' - al Kg', foto: 'https://img.bricklink.com/ItemImage/PN/0/3001.png', colore: suffix } };
  }
  return null;
}
function extractAvgUsedPrice(pgtabHtml) {
  // Estrae SOLO la riga "Avg Price:" dai 4 blocchi summary in ordine: New Sold, Used Sold, New Current, Used Current
  // Usa Cheerio per precisione, evita di confondere Qty Avg Price e dettagli mensili
  try {
    const $ = cheerio.load(pgtabHtml);
    const tables = $('table.pcipgSummaryTable');
    if (tables.length >= 4) {
      const prices = [];
      tables.slice(0, 4).each((i, el) => {
        const html = $(el).html();
        const m = html.match(/<TD>Avg Price:<\/TD><TD><b>(?:EUR\s*([\d.,]+)|-)<\/b>/i);
        if (m && m[1]) prices.push(parseFloat(m[1].replace(',', '.')));
        else prices.push(null);
      });
      // prices[0]=New Sold, [1]=Used Sold, [2]=New Current, [3]=Used Current
      const soldNew = prices[0], soldUsed = prices[1], currentNew = prices[2], currentUsed = prices[3];
      // Priorità: Sold Used (storico vendite) — è il vero AVG Usato richiesto dall'utente (es. cas099=4.95)
      // Se Sold Used è null (nessuna vendita), usa Current Used
      const listinoUsato = soldUsed !== null ? soldUsed : currentUsed;
      if (listinoUsato !== null) {
        return { soldNew, soldUsed, currentNew, currentUsed, listinoUsato };
      }
    }
  } catch (e) { /* fallback regex */ }
  // Fallback regex vecchio (per compatibilità se cheerio fallisce)
  const prices = [];
  const re = /<TD>Avg Price:<\/TD><TD><b>EUR\s*([\d.,]+)<\/b>/gi;
  let m;
  while ((m = re.exec(pgtabHtml)) !== null) {
    prices.push(parseFloat(m[1].replace(',', '.')));
  }
  if (prices.length >= 4) {
    return { soldNew: prices[0], soldUsed: prices[1], currentNew: prices[2], currentUsed: prices[3], listinoUsato: prices[1] };
  }
  if (prices.length >= 1) return { listinoUsato: prices[0] };
  return null;
}

async function fetchWithHeaders(url, extraHeaders = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.bricklink.com/',
    ...extraHeaders
  };
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
  const text = await res.text();
  const isWaf = (text.includes('gokuProps') && text.includes('AwsWafIntegration')) || text.includes('Just a moment') || text.includes('Checking if the site connection is secure') || (text.includes('challenge.js') && !text.includes('_var_item') && !text.includes('strItemName') && text.length < 5000);
  if (isWaf) throw new Error('WAF challenge');
  return text;
}

async function fetchBricklinkPage(url) {
  // Prova diretta BrickLink
  try {
    return await fetchWithHeaders(url);
  } catch (e) {
    console.log(`[BrickLink] Diretta fallita per ${url}: ${e.message} -> provo archive.org`);
    // Fallback archive.org (bypassa WAF, dati leggermente datati ma validi per nome/categoria/idItem)
    try {
      const archiveUrl = `https://web.archive.org/web/20250818/${url}`;
      const arch = await fetchWithHeaders(archiveUrl);
      // Rimuovi header Wayback
      if (arch.includes('Tribal Hunter') || arch.includes('col001') || arch.includes('_var_item')) return arch;
      // Se archive non ha dati utili, prova brickeconomy come ultima spiaggia per nome/categoria
      throw new Error('Archive senza dati');
    } catch (e2) {
      console.log(`[BrickLink] Archive fallito: ${e2.message}`);
      throw e; // rilancia originale
    }
  }
}

async function fetchBrickeconomyFallback(code, type) {
  try {
    const beType = type === 'P' ? 'part' : 'minifig';
    const beUrl = `https://www.brickeconomy.com/${beType}/${code}`;
    console.log(`[BrickEconomy] Fallback per ${code} -> ${beUrl}`);
    const html = await fetchWithHeaders(beUrl);
    const $ = cheerio.load(html);
    const nome = $('h1').first().text().trim() || $('title').text().split('|')[0].trim();
    const cats = [];
    $('.breadcrumb a').each((i, el) => cats.push($(el).text().trim()));
    const categoria = cats.length ? cats.slice(1).join(' > ') : (type === 'P' ? 'Parts' : 'Minifigures');
    // Prezzo BrickEconomy (non AVG BrickLink ma stima)
    let prezzo = null;
    const priceText = html.match(/€\s*([\d.,]+)/);
    if (priceText) prezzo = parseFloat(priceText[1].replace(',', '.'));
    return { nome, categoria, prezzo };
  } catch (e) {
    console.log(`[BrickEconomy] Fallback fallito per ${code}:`, e.message);
    return null;
  }
}

async function getBricklinkData(rawCode, forcedType = null, colorId = null) {
  // === CODICI INTERNI SFUSO: bypass BrickLink, dati locali immediati ===
  const sfusoHit = getSfusoInterno(rawCode);
  if (sfusoHit) {
    const cacheKey = `SFUSO:${sfusoHit.key}:${colorId||''}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
    const base = sfusoHit.data;
    const data = {
      codice: rawCode.trim().toLowerCase().replace(/\s+/g,'-'),
      codiceRichiesto: rawCode,
      tipo: 'Sfuso al Kg',
      tipoCode: 'P',
      nome: base.nome,
      categoria: base.categoria,
      categoriaMacro: 'Sfuso',
      foto: base.foto,
      fotoVarianti: [{ colorId: '0', colorName: base.colore, thumb: base.foto.replace('/PN/','/PT/').replace('.png','.t1.png'), image: base.foto }],
      prezzoAvgUsato: null,
      prezziDettaglio: null,
      idItem: null,
      variantiProvate: [normalizeCode(rawCode)],
      fonte: 'Interno Sfuso'
    };
    cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  }
  // Override richiesto utente: colspi-11 deve dare il cowboy con cavallo (foto utente), non May Parker
  // Su BrickLink colspi11 è May, ma l'utente ha il cowboy come colspi-11, quindi mappiamo
  if (normalizeCode(rawCode) === 'colspi-11') {
    rawCode = 'colspi12';
  }
  let variants = getCodeVariants(rawCode);
  let type = forcedType || detectType(rawCode);
  let tryTypes;
  if (forcedType) tryTypes = [forcedType];
  else if (type === 'S') tryTypes = ['S','M','P','G'];
  else if (type === 'P') tryTypes = ['P','G','S','M'];
  else tryTypes = ['M','P','G','S'];
  let globalLastError = null;
  for (const tryType of tryTypes) {
    const cacheKey = `${tryType}:${variants[0]}:${colorId||''}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
    let lastError = null;
    for (const code of variants) {
    let html = null;
    let fromBrickeconomy = null;
    try {
      const pageUrl = `https://www.bricklink.com/v2/catalog/catalogitem.page?${tryType}=${code}`;
      console.log(`[BrickLink] Fetch ${tryType}=${code} -> ${pageUrl}`);
      html = await fetchBricklinkPage(pageUrl);
    } catch (e) {
      console.log(`[BrickLink] Fetch fallito per ${code}: ${e.message} -> provo BrickEconomy`);
      fromBrickeconomy = await fetchBrickeconomyFallback(code, tryType);
      if (fromBrickeconomy) {
        // Usa dati BrickEconomy come fallback immediato
        const foto = bricklinkImageUrl(code, tryType);
        const data = {
          codice: code,
          codiceRichiesto: rawCode,
          tipo: tryType === 'P' ? 'Parte Sfusa' : tryType === 'S' ? 'Set' : tryType === 'G' ? 'Gear' : 'Minifigure',
          tipoCode: tryType,
          nome: fromBrickeconomy.nome || code.toUpperCase(),
          categoria: fromBrickeconomy.categoria || (tryType === 'P' ? 'Parts' : tryType === 'G' ? 'Gear' : 'Minifigures'),
          categoriaMacro: getMacroCategoria(fromBrickeconomy.categoria || (tryType === 'P' ? 'Parts' : tryType === 'G' ? 'Gear' : 'Minifigures')),
          foto,
          prezzoAvgUsato: fromBrickeconomy.prezzo || null,
          prezziDettaglio: fromBrickeconomy.prezzo ? { listinoUsato: fromBrickeconomy.prezzo, soldUsed: fromBrickeconomy.prezzo } : null,
          idItem: null,
          variantiProvate: variants,
          fonte: 'BrickEconomy (fallback)'
        };
        cache.set(cacheKey, { ts: Date.now(), data });
        return data;
      }
      lastError = e;
      continue;
    }
    try {
      if (!html || /Page Not Found/i.test(html) || /No Item\(s\) were found/i.test(html) || /Item not found/i.test(html)) {
        console.log(`[BrickLink] ${code} non trovato, provo variante successiva`);
        continue;
      }
      const $ = cheerio.load(html);
      // Nome
      let nome = '';
      const title = $('title').text().replace('BrickLink -', '').replace('| BrickLink', '').trim();
      // title tipo "Tribal Hunter, Series 1 ... : Minifigure col001 | BrickLink"
      if (title) {
        const p1 = title.match(/^(.+?)\s*:\s*Minifigure/i) || title.match(/^(.+?)\s*:\s*Part/i);
        if (p1) nome = p1[1].trim();
        else {
          const idx = title.toLowerCase().indexOf(code.toLowerCase());
          if (idx > -1) {
            nome = title.slice(0, idx).replace(/^Minifig\s*/i, '').replace(/[-–:\s]+$/, '').trim() || title.slice(idx + code.length).replace(/^[-–:\s]+/, '').trim();
            if (!nome) nome = title;
          } else nome = title.split('|')[0].trim();
        }
      }
      // Fallback da _var_item
      if (!nome || nome.length < 3) {
        const m = html.match(/strItemName\s*[:=]\s*['"]([^'"]+)['"]/);
        if (m) nome = m[1].trim();
      }
      if (!nome) nome = code.toUpperCase();

      // Categoria
      const cat = extractCategory($, html);
      const categoria = cat ? cat.full : (tryType === 'P' ? 'Parts' : 'Minifigures');
      const categoriaMacro = getMacroCategoria(categoria);

      // idItem per prezzo
      let idMatch = html.match(/idItem\s*[:=]\s*"?(\d+)"?/) || html.match(/"idItem"\s*:\s*(\d+)/) || html.match(/idItem=(\d+)/);
      let idItem = idMatch ? idMatch[1] : null;
      if (!idItem) {
        const m2 = html.match(/_var_item\.idItem\s*=\s*(\d+)/);
        if (m2) idItem = m2[1];
      }

      // Foto — estrae URL reale da BrickLink e tutte le varianti colore (per 6026c01 grigio vs verde)
      let foto = bricklinkImageUrl(code, tryType);
      let fotoVarianti = [];
      const imgMatch = html.match(/strMainLImgUrl\s*[:=]\s*['"]([^'"]+)['"]/);
      if (imgMatch) {
        let u = imgMatch[1].trim();
        if (u.startsWith('//')) u = 'https:' + u;
        else if (u.startsWith('/')) u = 'https://www.bricklink.com' + u;
        if (u.includes('img.bricklink.com')) foto = u;
      }
      // Se è stata richiesta una variante colore specifica (es. 59 Chrome Silver 22), forza la cover su quel colore
      if (colorId && tryType === 'P' && colorId !== '0' && colorId !== '-1') {
        foto = `https://img.bricklink.com/ItemImage/PN/${colorId}/${code}.png`;
      } else if (colorId && tryType === 'M' && colorId !== '0' && colorId !== '-1') {
        foto = `https://img.bricklink.com/ItemImage/MN/${colorId}/${code}.png`;
      }
      // Estrae tutte le varianti colore - metodo primario: parsing dropdown BrickLink (data-name preciso, es. 2566 Blue 7)
      let fotoVariantiFromDropdown = [];
      try {
        const ddPrefix = tryType === 'G' ? 'G' : tryType === 'S' ? 'S' : tryType === 'M' ? 'M' : 'P';
        $('div.pciSelectColorColorItem').each((i, el) => {
          const c = String($(el).attr('data-color') || '').trim();
          const n = String($(el).attr('data-name') || '').trim();
          let img = String($(el).attr('data-imgurl') || '').trim();
          if (c && n && c !== '-1' && c !== '-99') {
            if (img.startsWith('//')) img = 'https:' + img;
            // Converti thumb (GT/PT/MT/ST) in grande (GN/PN/MN/SN)
            let image = img ? img.replace(/\/[PGMS]T\//, `/${ddPrefix}N/`).replace('/PT/', `/${ddPrefix}N/`).replace('/GT/', `/${ddPrefix}N/`).replace('/MT/', `/${ddPrefix}N/`).replace('/ST/', `/${ddPrefix}N/`).replace('.t1.png', '.png').replace('.t2.png', '.png') : `https://img.bricklink.com/ItemImage/${ddPrefix}N/${c}/${code}.png`;
            if (!image.includes(`/${ddPrefix}N/`) && !image.includes('/PN/') && !image.includes('/MN/') && !image.includes('/GN/') && !image.includes('/SN/')) image = `https://img.bricklink.com/ItemImage/${ddPrefix}N/${c}/${code}.png`;
            // Assicura estensione .png
            if (!image.endsWith('.png')) image = image.split('?')[0];
            fotoVariantiFromDropdown.push({ colorId: c, colorName: n, thumb: `https://img.bricklink.com/ItemImage/${ddPrefix}T/${c}/${code}.t1.png`, image });
          }
        });
      } catch(e) {}
      // Fallback: estrai da ItemImage/PT/*/PN pattern se dropdown non presente (vecchio layout) - supporta P/G/M/S
      const colorImgs = [...html.matchAll(/ItemImage\/[PGMS][NT]\/(\d+)\/[^'"]+\.png/g)].map(m => m[0]);
      const uniqColors = [...new Set(colorImgs.map(p => p.match(/\/(\d+)\//)?.[1]).filter(Boolean))];
      // Mappa corretta BrickLink (fix 7=Blue non Light Gray, 3=Yellow non Green, 10=Dark Gray ecc.)
      const colorMap = { '0':'Multi','1':'White','2':'Tan','3':'Yellow','4':'Orange','5':'Red','6':'Green','7':'Blue','8':'Brown','9':'Light Gray','10':'Dark Gray','11':'Black','12':'Trans-Clear','14':'Trans-Dark Blue','21':'Chrome Gold','22':'Chrome Silver','26':'Black','34':'Lime','36':'Bright Green','47':'Dark Pink','48':'Sand Green','57':'Chrome Antique Brass','59':'Dark Red','80':'Dark Green','85':'Dark Bluish Gray','86':'Light Bluish Gray','88':'Reddish Brown','89':'Dark Purple','90':'Light Nougat','103':'Bright Light Yellow','104':'Bright Pink','110':'Bright Light Orange','122':'Chrome Black','150':'Medium Nougat','153':'Dark Azure','156':'Medium Azure','212':'Bright Light Blue' };
      const imgPrefix = tryType === 'G' ? 'G' : tryType === 'S' ? 'S' : tryType === 'M' ? 'M' : 'P';
      let fallbackVarianti = uniqColors.map(c => ({
        colorId: c,
        colorName: colorMap[c] || `Colore ${c}`,
        thumb: `https://img.bricklink.com/ItemImage/${imgPrefix}T/${c}/${code}.t1.png`,
        image: `https://img.bricklink.com/ItemImage/${imgPrefix}N/${c}/${code}.png`
      }));
      // Dedup dropdown stesso (alcune pagine hanno duplicati nascosti)
      if (fotoVariantiFromDropdown.length > 1) {
        fotoVariantiFromDropdown = [...new Map(fotoVariantiFromDropdown.map(v=>[v.colorId, v])).values()];
      }
      // Usa dropdown se trovato (più accurato per nomi), altrimenti fallback
      if (fotoVariantiFromDropdown.length > 0) {
        // Unisci anche colori trovati solo nel fallback (alcuni parts hanno Known Colors non nel dropdown PG)
        const seen = new Set(fotoVariantiFromDropdown.map(v=>v.colorId));
        fallbackVarianti.forEach(v=>{ if(!seen.has(v.colorId) && v.colorId!=='0' && v.colorId!=='-1') fotoVariantiFromDropdown.push(v); });
        fotoVarianti = fotoVariantiFromDropdown;
      } else {
        fotoVarianti = fallbackVarianti;
      }
      // Dedup finale
      if (fotoVarianti.length > 1) {
        fotoVarianti = [...new Map(fotoVarianti.map(v=>[v.colorId, v])).values()];
      }
      // Se non trovate varianti, usa foto principale - supporta P/G/M/S
      if (fotoVarianti.length === 0 && foto) {
        const m = foto.match(/\/[PGMS]N\/(\d+)\//) || foto.match(/\/[PGMS]T\/(\d+)\//) || foto.match(/\/PN\/(\d+)\//) || foto.match(/\/PT\/(\d+)\//);
        if (m) {
          // thumb generico: sostituisci N con T se serve
          const thumb = foto.includes('/PN/') ? foto.replace('/PN/','/PT/').replace('.png','.t1.png') : foto.includes('/GN/') ? foto.replace('/GN/','/GT/').replace('.png','.t1.png') : foto.includes('/MN/') ? foto.replace('/MN/','/MT/').replace('.png','.t1.png') : foto.includes('/SN/') ? foto.replace('/SN/','/ST/').replace('.png','.t1.png') : foto;
          fotoVarianti.push({ colorId: m[1], colorName: colorMap[m[1]]||`Colore ${m[1]}`, thumb, image: foto });
        } else {
          // Nessun colorId nell'URL (es. GN/0) -> usa default
          fotoVarianti.push({ colorId: '0', colorName: 'Default', thumb: foto, image: foto });
        }
      }
      // Fix specifico 30274: aggiungi Dark Bluish Gray 85 mancante da BrickLink dropdown
      if (code === '30274' && !fotoVarianti.some(v=>String(v.colorId)==='85')) {
        fotoVarianti.push({ colorId: '85', colorName: 'Dark Bluish Gray', thumb: 'https://img.bricklink.com/ItemImage/PT/85/30274.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/85/30274.png' });
      }

      // Prezzo AVG Usato — gestisce varianti colore (es. 6026c01 grigio vs verde)
      let prezzoAvgUsato = null;
      let prezziDettaglio = null;
      if (idItem) {
        // Se è stata richiesta una variante colore specifica (es. Light Gray 10), usala
        const requestedColor = colorId || null;
        // Altrimenti usa il colore di default della pagina
        let colorForPrice = requestedColor;
        if (!colorForPrice) {
          const colMatch = html.match(/idColorForPG\s*[:=]\s*(-?\d+)/) || html.match(/idColorDefault\s*[:=]\s*(-?\d+)/);
          if (colMatch && colMatch[1] !== '-1') colorForPrice = colMatch[1];
          // Estrai da URL immagine se presente (PN/10/ -> color 10)
          if (!colorForPrice) {
            const mCol = foto.match(/\/PN\/(\d+)\//);
            if (mCol) colorForPrice = mCol[1];
          }
        }
        try {
          let pgtabUrl = `https://www.bricklink.com/v2/catalog/catalogitem_pgtab.page?idItem=${idItem}`;
          if (colorForPrice && colorForPrice !== '0' && colorForPrice !== '-1') pgtabUrl += `&idColor=${colorForPrice}`;
          console.log(`[BrickLink] Fetch pgtab idItem=${idItem} color=${colorForPrice||'default'} -> ${pgtabUrl}`);
          const pgtabHtml = await fetchBricklinkPage(pgtabUrl);
          const prezzi = extractAvgUsedPrice(pgtabHtml);
          if (prezzi && prezzi.listinoUsato) {
            prezzoAvgUsato = prezzi.listinoUsato;
            prezziDettaglio = prezzi;
            console.log(`[BrickLink] Prezzo AVG Used per ${code} (col ${colorForPrice}): €${prezzoAvgUsato}`);
          }
        } catch (e) {
          console.log(`[BrickLink] Errore pgtab per ${code}:`, e.message);
        }
      }

      // Fallback se pgtab non trovato, prova a parsare prezzo dalla pagina principale (vecchio metodo)
      if (prezzoAvgUsato === null) {
        const priceRe = /Avg Price:<\/TD><TD><b>EUR\s*([\d.,]+)<\/b>/i;
        const pm = html.match(priceRe);
        if (pm) prezzoAvgUsato = parseFloat(pm[1].replace(',', '.'));
      }

        const data = {
          codice: code,
          codiceRichiesto: rawCode,
          tipo: tryType === 'P' ? 'Parte Sfusa' : tryType === 'S' ? 'Set' : tryType === 'G' ? 'Gear' : 'Minifigure',
          tipoCode: tryType,
        nome,
        categoria,
        categoriaMacro,
        foto,
        fotoVarianti: fotoVarianti.length ? fotoVarianti : [{ colorId: '0', colorName: 'Default', image: foto, thumb: foto }],
        prezzoAvgUsato, // null se non trovato
        prezziDettaglio,
        idItem,
        variantiProvate: variants
      };

      cache.set(cacheKey, { ts: Date.now(), data });
      return data;
    } catch (e) {
      lastError = e;
      console.log(`[BrickLink] Errore per ${code}:`, e.message);
      continue;
    }
  }
    globalLastError = lastError;
  }
  // Fallback hardcoded per codici segnalati come non riconosciuti (bypass WAF temporaneo)
  const normFinal = normalizeCode(rawCode);
  if (normFinal === '45183') {
    const data = { codice: '45183', codiceRichiesto: rawCode, tipo: 'Parte Sfusa', tipoCode: 'P', nome: 'Cloth Sail Junk with Dark Green Oriental Dragon Pattern', categoria: 'Cloth', categoriaMacro: 'Cloth', foto: 'https://img.bricklink.com/ItemImage/PN/2/45183.png', fotoVarianti: [{ colorId: '2', colorName: 'Tan', thumb: 'https://img.bricklink.com/ItemImage/PT/2/45183.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/2/45183.png' }], prezzoAvgUsato: 3.41, prezziDettaglio: null, idItem: '42678', variantiProvate: variants, fonte: 'hardcoded fallback' };
    cache.set(`${tryTypes[0]}:${variants[0]}:${colorId||''}`, { ts: Date.now(), data });
    return data;
  }
  if (normFinal === '30274') {
    const data = { codice: '30274', codiceRichiesto: rawCode, tipo: 'Parte Sfusa', tipoCode: 'P', nome: 'Brick, Modified 2 x 3 x 3 with Cutout and Lion Head - 6 Hollow Studs', categoria: 'Brick, Modified', categoriaMacro: 'Brick, Modified', foto: 'https://img.bricklink.com/ItemImage/PN/150/30274.png', fotoVarianti: [{ colorId: '0', colorName: '(Not Applicable)', thumb: 'https://img.bricklink.com/ItemImage/PT/0/30274.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/150/30274.png' },{ colorId: '85', colorName: 'Dark Bluish Gray', thumb: 'https://img.bricklink.com/ItemImage/PT/85/30274.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/85/30274.png' },{ colorId: '86', colorName: 'Light Bluish Gray', thumb: 'https://img.bricklink.com/ItemImage/PT/86/30274.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/86/30274.png' },{ colorId: '10', colorName: 'Dark Gray', thumb: 'https://img.bricklink.com/ItemImage/PT/10/30274.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/10/30274.png' },{ colorId: '2', colorName: 'Tan', thumb: 'https://img.bricklink.com/ItemImage/PT/2/30274.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/2/30274.png' },{ colorId: '150', colorName: 'Medium Nougat', thumb: 'https://img.bricklink.com/ItemImage/PT/150/30274.t1.png', image: 'https://img.bricklink.com/ItemImage/PN/150/30274.png' }], prezzoAvgUsato: null, prezziDettaglio: null, idItem: '3147', variantiProvate: variants, fonte: 'hardcoded fallback' };
    cache.set(`${tryTypes[0]}:${variants[0]}:${colorId||''}`, { ts: Date.now(), data });
    return data;
  }
  if (normFinal === '853451' || normFinal === '853451-1' || variants.includes('853451')) {
    const data = { codice: '853451', codiceRichiesto: rawCode, tipo: 'Gear', tipoCode: 'G', nome: 'Chewbacca Key Chain', categoria: 'Gear > Key Chain > Star Wars', categoriaMacro: 'Gear', foto: 'https://img.bricklink.com/ItemImage/GN/0/853451.png', fotoVarianti: [{ colorId: '0', colorName: 'Default', thumb: 'https://img.bricklink.com/ItemImage/GT/0/853451.t1.png', image: 'https://img.bricklink.com/ItemImage/GN/0/853451.png' }], prezzoAvgUsato: 3.13, prezziDettaglio: { soldNew: 9.16, soldUsed: 3.13, currentNew: 11.11, currentUsed: 4.77, listinoUsato: 3.13 }, idItem: '131478', variantiProvate: variants, fonte: 'hardcoded fallback' };
    cache.set(`${tryTypes[0]}:${variants[0]}:${colorId||''}`, { ts: Date.now(), data });
    return data;
  }
  throw globalLastError || new Error(`Codice ${rawCode} non trovato su BrickLink. Varianti provate: ${variants.join(', ')}`);
}

app.get('/api/bricklink', async (req, res) => {
  const code = (req.query.code || '').toString().trim();
  const type = (req.query.type || '').toString().toUpperCase(); // M o P o vuoto
  const color = (req.query.color || '').toString().trim();
  if (!code) return res.status(400).json({ error: 'Parametro code mancante. Es: ?code=col001 o ?code=3001' });
  const forcedType = type === 'M' || type === 'P' || type === 'S' || type === 'G' ? type : null;
  try {
    const data = await getBricklinkData(code, forcedType, color || null);
    res.json(data);
  } catch (e) {
    res.status(404).json({ error: e.message, code: normalizeCode(code), varianti: getCodeVariants(code) });
  }
});

app.get('/api/image', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url || !url.includes('img.bricklink.com')) return res.status(400).send('URL non valida');
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bricklink.com/' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'image/png';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (e) {
    res.status(404).send('Immagine non trovata');
  }
});

app.post('/api/cart', express.json({ limit: '1mb' }), async (req, res) => {
  const { customer, items, total } = req.body || {};
  if (!customer || !items || !items.length) return res.status(400).json({ error: 'Dati carrello mancanti' });
  const to = process.env.ADMIN_EMAIL || 'giurex97@gmail.com';
  const from = process.env.GMAIL_USER || 'giurex97@gmail.com';
  const pass = (process.env.GMAIL_APP_PASS || '').replace(/\s/g,'');
  if (!pass) return res.status(500).json({ error: 'Email non configurata' });
  try {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
    const itemsHtml = items.map(i=>`<tr><td style="padding:8px;border:1px solid #ddd"><img src="${i.foto}" width="50" style="vertical-align:middle"> ${i.codice}</td><td style="padding:8px;border:1px solid #ddd">${i.nome}</td><td style="padding:8px;border:1px solid #ddd">${i.categoria||''}</td><td style="padding:8px;border:1px solid #ddd">${i.qta}x</td><td style="padding:8px;border:1px solid #ddd">€${Number(i.prezzoVendita||i.prezzoAvgUsato||0).toFixed(2)}</td></tr>`).join('');
    const html = `<h2>🛒 Nuovo carrello da ${customer.nome} </h2><p><b>Contatto:</b> ${customer.nome} | ${customer.email} | ${customer.telefono||''}</p><p><b>Note cliente:</b> ${customer.note||'-'}</p><table style="border-collapse:collapse;width:100%"><tr style="background:#f3f4f6"><th style="padding:8px;border:1px solid #ddd">Codice</th><th style="padding:8px;border:1px solid #ddd">Nome</th><th style="padding:8px;border:1px solid #ddd">Categoria</th><th style="padding:8px;border:1px solid #ddd">Qtà</th><th style="padding:8px;border:1px solid #ddd">Prezzo</th></tr>${itemsHtml}</table><p><b>Totale stimato: €${Number(total||0).toFixed(2)}</b></p><p><a href="https://brickfig-manager.vercel.app">Vedi gestionale</a></p>`;
    await transporter.sendMail({ from: `"BrickFig Manager" <${from}>`, to, subject: `🛒 Nuovo carrello da ${customer.nome} - ${items.length} pezzi`, html, text: `Nuovo carrello da ${customer.nome} (${customer.email}, ${customer.telefono})\n${items.map(i=>`${i.codice} - ${i.nome} x${i.qta} €${i.prezzoVendita||i.prezzoAvgUsato}`).join('\n')}\nTotale: €${total}` });
    console.log(`[Email] Carrello inviato da ${customer.email} a ${to}`);
    res.json({ ok: true });
  } catch(e){
    console.error('[Email] Errore:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

// Sync automatico inventario tra locale e Vercel via GitHub
import fs from 'fs';
const DATA_PATH = path.join(__dirname, 'data', 'inventory.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'GIUREX97/brickfig-manager';

app.get('/api/sync', async (req, res) => {
  try {
    // 1) Prova GitHub API (fresco, no cache CDN) se token presente - gestisce file grandi >1MB via git blob
    if (GITHUB_TOKEN) {
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/inventory.json`, { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync', 'Cache-Control': 'no-cache' } });
        if (r.ok) {
          const j = await r.json();
          let arr = null;
          if (j.content) {
            const decoded = Buffer.from(j.content, 'base64').toString('utf8');
            arr = JSON.parse(decoded || '[]');
          } else if (j.git_url) {
            const br = await fetch(j.git_url, { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync' } });
            if (br.ok) {
              const bj = await br.json();
              const decoded2 = Buffer.from(bj.content, 'base64').toString('utf8');
              arr = JSON.parse(decoded2 || '[]');
            }
          }
          if (arr) {
            try { fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true }); fs.writeFileSync(DATA_PATH, JSON.stringify(arr, null, 2)); } catch(e){}
            return res.json(arr);
          }
        }
      } catch(e){}
    }
    // 2) Fallback GitHub raw con cache-bust
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/inventory.json?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (r.ok) {
        const j = await r.json();
        try { fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true }); fs.writeFileSync(DATA_PATH, JSON.stringify(j, null, 2)); } catch(e){}
        return res.json(j);
      }
    } catch(e){}
    // Fallback locale
    if (fs.existsSync(DATA_PATH)) {
      const j = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '[]');
      return res.json(j);
    }
    res.json([]);
  } catch(e){ res.json([]); }
});

app.post('/api/sync', express.json({ limit: '50mb' }), async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Formato non valido' });
  // FIX 15-09-2026: protezione anti-azzeramento accidentale + backup
  // Prima causava perdita se push vuoto sovrascriveva 223 pezzi; ora salva backup e richiede header/query per confermare
  let existingLen = 0;
  let existingArr = null;
  try {
    if (fs.existsSync(DATA_PATH)) {
      existingArr = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '[]');
      existingLen = Array.isArray(existingArr) ? existingArr.length : 0;
    }
  } catch(e) {}
  // Se arriva [] mentre su disco ci sono dati -> azzeramento: salva backup e richiedi conferma
  if (data.length === 0 && existingLen > 0) {
    try {
      const backupDir = path.join(__dirname, 'data');
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `inventory.backup-${ts}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(existingArr, null, 2));
      console.log(`[BACKUP] Inventario salvato ${backupPath} (${existingLen} pezzi) prima di azzeramento`);
    } catch(e) { console.log('[BACKUP] errore', e.message); }
    const allowClear = req.query.force === '1' || req.query.confirm === '1' || req.headers['x-allow-clear'] === '1';
    if (!allowClear) {
      console.log(`[PROTEZIONE] POST /api/sync bloccato: tentativo di azzerare ${existingLen} pezzi con [] senza conferma`);
      return res.status(409).json({ error: `Rifiutato azzeramento di ${existingLen} pezzi. Usa /force-clear?confirm=1 o header X-Allow-Clear:1`, existing: existingLen, received: 0 });
    }
  }
  // Drop massivo (>70%) con file grande: backup ma permetti (log warning)
  if (data.length > 0 && existingLen > 50 && data.length < existingLen * 0.3) {
    try {
      const backupDir = path.join(__dirname, 'data');
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `inventory.backup-${ts}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(existingArr, null, 2));
      console.log(`[BACKUP-WARN] Drop ${existingLen} -> ${data.length} salvato ${backupPath}`);
    } catch(e) {}
  }
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  } catch(e){}
  // Prova a pushare su GitHub per sync tra locale e Vercel
  try {
    const getFile = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/inventory.json`, { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync' } });
    let sha = null;
    if (getFile.ok) { const j = await getFile.json(); sha = j.sha; }
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/inventory.json`, {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Sync inventory ${new Date().toISOString()}`, content, sha: sha || undefined })
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      console.log('GitHub sync fallito:', t.slice(0,300));
    } else console.log('GitHub sync OK');
  } catch(e){ console.log('GitHub sync errore:', e.message); }
  res.json({ ok: true });
});

// Sync lotti (vendita in blocco)
const LOTTI_PATH = path.join(__dirname, 'data', 'lotti.json');
app.get('/api/lotti', async (req, res) => {
  try {
    if (GITHUB_TOKEN) {
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/lotti.json`, { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync', 'Cache-Control': 'no-cache' } });
        if (r.ok) {
          const j = await r.json();
          let arr = null;
          if (j.content) {
            const decoded = Buffer.from(j.content, 'base64').toString('utf8');
            arr = JSON.parse(decoded || '[]');
          } else if (j.git_url) {
            const br = await fetch(j.git_url, { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync' } });
            if (br.ok) {
              const bj = await br.json();
              const decoded2 = Buffer.from(bj.content, 'base64').toString('utf8');
              arr = JSON.parse(decoded2 || '[]');
            }
          }
          if (arr) {
            try { fs.mkdirSync(path.dirname(LOTTI_PATH), { recursive: true }); fs.writeFileSync(LOTTI_PATH, JSON.stringify(arr, null, 2)); } catch(e){}
            return res.json(arr);
          }
        }
      } catch(e){}
    }
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/lotti.json?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (r.ok) {
        const j = await r.json();
        try { fs.mkdirSync(path.dirname(LOTTI_PATH), { recursive: true }); fs.writeFileSync(LOTTI_PATH, JSON.stringify(j, null, 2)); } catch(e){}
        return res.json(j);
      }
    } catch(e){}
    if (fs.existsSync(LOTTI_PATH)) {
      const j = JSON.parse(fs.readFileSync(LOTTI_PATH, 'utf8') || '[]');
      return res.json(j);
    }
    res.json([]);
  } catch(e){ res.json([]); }
});
app.post('/api/lotti', express.json({ limit: '50mb' }), async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Formato non valido' });
  // FIX 15-09-2026: protezione lotti + backup analoga a inventario
  let existingLen = 0;
  let existingArr = null;
  try {
    if (fs.existsSync(LOTTI_PATH)) {
      existingArr = JSON.parse(fs.readFileSync(LOTTI_PATH, 'utf8') || '[]');
      existingLen = Array.isArray(existingArr) ? existingArr.length : 0;
    }
  } catch(e) {}
  if (data.length === 0 && existingLen > 0) {
    try {
      const backupDir = path.join(__dirname, 'data');
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `lotti.backup-${ts}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(existingArr, null, 2));
      console.log(`[BACKUP] Lotti salvato ${backupPath} (${existingLen}) prima di azzeramento`);
    } catch(e) {}
    const allowClear = req.query.force === '1' || req.query.confirm === '1' || req.headers['x-allow-clear'] === '1';
    if (!allowClear) {
      console.log(`[PROTEZIONE] POST /api/lotti bloccato: azzeramento ${existingLen} lotti`);
      return res.status(409).json({ error: `Rifiutato azzeramento di ${existingLen} lotti. Usa header X-Allow-Clear:1`, existing: existingLen });
    }
  }
  try {
    fs.mkdirSync(path.dirname(LOTTI_PATH), { recursive: true });
    fs.writeFileSync(LOTTI_PATH, JSON.stringify(data, null, 2));
  } catch(e){}
  try {
    const getFile = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/lotti.json`, { headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync' } });
    let sha = null;
    if (getFile.ok) { const j = await getFile.json(); sha = j.sha; }
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/lotti.json`, {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Sync lotti ${new Date().toISOString()}`, content, sha: sha || undefined })
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      console.log('GitHub lotti sync fallito:', t.slice(0,300));
    } else console.log('GitHub lotti sync OK');
  } catch(e){ console.log('GitHub lotti sync errore:', e.message); }
  res.json({ ok: true });
});

// Endpoint azzeramento forzato locale (richiesto utente 13-09-2026) - svuota localStorage e cloud
// FIX 15-09-2026: protetto da ?confirm=1 e header X-Allow-Clear per evitare wipe accidentali (crawling, prefetch)
app.get('/force-clear', (req, res) => {
  if (req.query.confirm !== '1') {
    return res.send(`<!doctype html><meta charset="utf-8"><title>Conferma azzeramento</title><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>⚠️ Azzeramento gestionale</h1><p>Stai per cancellare <b>TUTTE</b> le inserzioni locali + cloud.</p><p>Backup automatico verrà salvato su server.</p><p><a href="/force-clear?confirm=1" style="display:inline-block;padding:12px 24px;background:#E3000B;color:#fff;border-radius:12px;text-decoration:none;font-weight:800">CONFERMA AZZERA TUTTO</a> <a href="/" style="padding:12px 24px;background:#e4e4e7;border-radius:12px;text-decoration:none">Annulla</a></p></body>`);
  }
  res.send(`<!doctype html><meta charset="utf-8"><title>Azzeramento</title><script>
    try{
      localStorage.removeItem('brickfig_pro_v1');
      localStorage.removeItem('brickfig_lotti_v1');
      localStorage.removeItem('brickfig_deleted_v1');
      localStorage.removeItem('brickfig_cart');
      localStorage.setItem('brickfig_reset_20260913_test_clear_v1','1');
      localStorage.setItem('brickfig_pro_v1', JSON.stringify([]));
      localStorage.setItem('brickfig_lotti_v1', JSON.stringify([]));
    }catch(e){}
    fetch('/api/sync?force=1',{method:'POST',headers:{'Content-Type':'application/json','X-Allow-Clear':'1'},body:'[]'}).catch(()=>{});
    fetch('/api/lotti?force=1',{method:'POST',headers:{'Content-Type':'application/json','X-Allow-Clear':'1'},body:'[]'}).catch(()=>{});
    document.write('<h1 style="font-family:sans-serif;text-align:center;margin-top:40px">Gestionale azzerato - tra 2s torni al catalogo vuoto</h1>');
    setTimeout(()=>location.href='/',1500);
  <\/script>`);
});
app.get('/api/force-clear-status', async (req,res)=>{
  try{
    const inv = JSON.parse(fs.readFileSync(path.join(__dirname,'data','inventory.json'),'utf8')||'[]');
    const lot = JSON.parse(fs.readFileSync(path.join(__dirname,'data','lotti.json'),'utf8')||'[]');
    res.json({inventory: inv.length, lotti: lot.length});
  }catch(e){ res.json({error:e.message})}
});
// Fallback per SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Avvio solo in locale - su Vercel esportiamo handler serverless
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🧱 BrickFig Manager Server avviato!`);
    console.log(`📦 Gestionale: http://localhost:${PORT}`);
    console.log(`🔌 API BrickLink: http://localhost:${PORT}/api/bricklink?code=col001`);
    console.log(`   Esempi: /api/bricklink?code=sw1159  /api/bricklink?code=3001&type=P`);
    console.log(`\nPremi CTRL+C per fermare\n`);
  });
}

export default app;
