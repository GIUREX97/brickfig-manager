import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import fs from 'fs';
import { calcolaPreventivo, generaCodicePreventivo } from './spedizioni-logic.js';
import { initTelegramBot, notifyNewQuote, sendToAllAdmins, testBot, getAdminIds } from './telegram-bot.js';

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
    else if (p.includes('/data/photos/') || p.includes('\\data\\photos\\')) { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); }
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
// Solo sfuso: NESSUNA immagine BrickLink di copertina (foto=''), solo foto reali caricate dall'utente
const SFUSO_INTERNI = {
  'sfusomisto':               { nome: 'Sfuso Misto',                categoria: 'Sfuso > Misto - al Kg',              foto: '',  colore: 'Misto' },
  'sfusotechnic':             { nome: 'Sfuso Technic',              categoria: 'Sfuso > Technic - al Kg',            foto: '',  colore: 'Technic' },
  'sfusodarkbluishgrey':      { nome: 'Sfuso Dark Bluish Grey',     categoria: 'Sfuso > Dark Bluish Grey - al Kg',   foto: '', colore: 'Dark Bluish Grey' },
  'sfusodbg':                 { nome: 'Sfuso Dark Bluish Grey',     categoria: 'Sfuso > Dark Bluish Grey - al Kg',   foto: '', colore: 'Dark Bluish Grey' },
  'sfusolightbluishgrey':     { nome: 'Sfuso Light Bluish Grey',    categoria: 'Sfuso > Light Bluish Grey - al Kg',  foto: '', colore: 'Light Bluish Grey' },
  'sfusolbg':                 { nome: 'Sfuso Light Bluish Grey',    categoria: 'Sfuso > Light Bluish Grey - al Kg',  foto: '', colore: 'Light Bluish Grey' },
  'sfusotan':                 { nome: 'Sfuso Tan',                  categoria: 'Sfuso > Tan - al Kg',                foto: '',  colore: 'Tan' },
  'sfusoreddishbrown':        { nome: 'Sfuso Reddish Brown',        categoria: 'Sfuso > Reddish Brown - al Kg',      foto: '', colore: 'Reddish Brown' },
  'sfusorb':                  { nome: 'Sfuso Reddish Brown',        categoria: 'Sfuso > Reddish Brown - al Kg',      foto: '', colore: 'Reddish Brown' },
  'sfusodarktan':             { nome: 'Sfuso Dark Tan',             categoria: 'Sfuso > Dark Tan - al Kg',           foto: '', colore: 'Dark Tan' },
  'sfusodt':                  { nome: 'Sfuso Dark Tan',             categoria: 'Sfuso > Dark Tan - al Kg',           foto: '', colore: 'Dark Tan' },
  'sfusopearlgold':           { nome: 'Sfuso Pearl Gold',           categoria: 'Sfuso > Pearl Gold - al Kg',         foto: '',colore: 'Pearl Gold' },
  'sfusopg':                  { nome: 'Sfuso Pearl Gold',           categoria: 'Sfuso > Pearl Gold - al Kg',         foto: '',colore: 'Pearl Gold' },
  'sfusopearlgold':           { nome: 'Sfuso Pearl Gold',           categoria: 'Sfuso > Pearl Gold - al Kg',         foto: '',colore: 'Pearl Gold' },
  'sfusofig':                 { nome: 'Sfuso Fig',                  categoria: 'Sfuso > Fig - al Kg',                foto: '',     colore: 'Fig' },
  'sfusotile':                { nome: 'Sfuso Tile',                 categoria: 'Sfuso > Tile - al Kg',               foto: '',  colore: 'Tile' },
};
function normalizeSfusoKey(input){
  return input.trim().toLowerCase().replace(/[\s\-_]+/g, '').replace(/[^a-z0-9]/g,'');
}
function getSfusoInterno(rawCode){
  const key = normalizeSfusoKey(rawCode);
  // accetta anche con prefisso sfuso- generico: sfuso-qualcosa -> cerca esatto o crea generico
  if (SFUSO_INTERNI[key]) return { key, data: SFUSO_INTERNI[key] };
  // se inizia con sfuso ma non in mappa, crea generico al volo - SENZA foto BrickLink
  if (key.startsWith('sfuso') && key.length>5){
    const suffix = rawCode.trim().replace(/^sfuso[\s\-_]*/i,'').trim() || key.slice(5);
    const nome = 'Sfuso ' + suffix.split(/[\s\-_]+/).map(w=> w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
    return { key, data: { nome: nome, categoria: 'Sfuso > '+suffix+' - al Kg', foto: '', colore: suffix } };
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
    const hasFoto = base.foto && base.foto.startsWith('http');
    const data = {
      codice: rawCode.trim().toLowerCase().replace(/\s+/g,'-'),
      codiceRichiesto: rawCode,
      tipo: 'Sfuso al Kg',
      tipoCode: 'P',
      nome: base.nome,
      categoria: base.categoria,
      categoriaMacro: 'Sfuso',
      foto: base.foto || '',
      fotoVarianti: hasFoto ? [{ colorId: '0', colorName: base.colore, thumb: base.foto.replace('/PN/','/PT/').replace('.png','.t1.png'), image: base.foto }] : [],
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

// ==================== DISNEY US vs EU COMPARATOR ====================
const disneyCache = new Map();
const DISNEY_TTL = 1000 * 60 * 30; // 30 min

function cleanText(s){ return (s||'').replace(/\s+/g,' ').trim(); }

function parseDisneyProduct(html, url){
  try{
    const $ = cheerio.load(html);
    let rawTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content') || $('meta[property="og:title"]').attr('content') || '';
    let titleTag = cleanText($('title').text().split('|')[0].split('—')[0].trim());
    // Sanitize titleTag: if contains icon spam or too long, ignore
    if(titleTag && (titleTag.includes('Search Icon') || titleTag.includes('Icon') && titleTag.length>60 || titleTag.length>120)){
      // try to extract first meaningful part before icon
      const m = titleTag.match(/^(.+?)(Search Icon|Caret|Checkbox)/);
      if(m) titleTag = cleanText(m[1]);
      else titleTag='';
    }
    let title = cleanText(rawTitle || titleTag);
    if(!title || title.toLowerCase().includes('page not found') && title.length<40) {
      // keep as is for notFound detection but fallback to h1 if h1 exists and is not polluted
      const h1 = cleanText($('h1').first().text());
      if(h1 && !h1.includes('Search Icon') && h1.length<80) title = h1;
    }
    if(!title) title = cleanText($('h1').first().text());
    // limit title length
    if(title && title.length>120) title = title.slice(0,120).trim();
    // Try JSON-LD
    let ldTitle=null, ldPrice=null, ldCurrency=null, ldAvailability=null, ldImage=null, ldSku=null;
    $('script[type="application/ld+json"]').each((i,el)=>{
      try{
        const raw = $(el).html();
        if(!raw) return;
        const data = JSON.parse(raw);
        const arr = Array.isArray(data) ? data : [data];
        arr.forEach(obj=>{
          if(obj['@type']==='Product' || obj.name){
            ldTitle = ldTitle || obj.name;
            ldImage = ldImage || (Array.isArray(obj.image)? obj.image[0] : obj.image);
            ldSku = ldSku || obj.sku || obj.mpSKU;
            if(obj.offers){
              const off = Array.isArray(obj.offers)? obj.offers[0] : obj.offers;
              ldPrice = ldPrice || off.price || off.lowPrice;
              ldCurrency = ldCurrency || off.priceCurrency;
              ldAvailability = ldAvailability || off.availability;
            }
          }
          // graph
          if(obj['@graph']){
            obj['@graph'].forEach(g=>{
              if(g['@type']==='Product'){
                ldTitle = ldTitle || g.name;
                ldImage = ldImage || (Array.isArray(g.image)? g.image[0] : g.image);
                ldSku = ldSku || g.sku;
                if(g.offers){
                  const off = Array.isArray(g.offers)? g.offers[0] : g.offers;
                  ldPrice = ldPrice || off.price;
                  ldCurrency = ldCurrency || off.priceCurrency;
                  ldAvailability = ldAvailability || off.availability;
                }
              }
            });
          }
        });
      }catch(e){}
    });
    if(ldTitle) title = ldTitle;

    // Price extraction
    let price = ldPrice ? Number(String(ldPrice).replace(',','.')) : null;
    let currency = ldCurrency || null;
    let priceRaw = null;
    if(!price){
      // meta product:price
      const metaPrice = $('meta[property="product:price:amount"]').attr('content') || $('meta[property="og:price:amount"]').attr('content');
      const metaCurr = $('meta[property="product:price:currency"]').attr('content') || $('meta[property="og:price:currency"]').attr('content');
      if(metaPrice){ price = Number(metaPrice.replace(',','.')); currency = metaCurr||currency; priceRaw = metaPrice; }
    }
    if(!price){
      // DOM selectors
      const priceSelectors = ['[data-testid*="price"]','[data-test*="price"]','.price','.product-price','.sales','.value','[class*="Price"]','[class*="price"]'];
      for(const sel of priceSelectors){
        const t = cleanText($(sel).first().text());
        const m = t.match(/([€$£])\s*([\d,]+\.\d{2})|([\d,]+\.\d{2})\s*([€$£])|€\s*([\d.,]+)|\$\s*([\d.,]+)/);
        if(m){
          const numStr = (m[2]||m[3]||m[5]||m[6]||'').replace(/,/g,'');
          const v = Number(numStr);
          if(v>0 && v<10000){ price=v; priceRaw=t; currency = t.includes('€')?'EUR': t.includes('$')?'USD': t.includes('£')?'GBP': currency; break; }
        }
      }
    }
    if(!price){
      // regex on whole html
      const htmlPriceUSD = html.match(/\$\s*([\d,]+\.\d{2})/);
      const htmlPriceEUR = html.match(/€\s*([\d.,]+)/);
      if(htmlPriceEUR){ price = Number(htmlPriceEUR[1].replace(/\./g,'').replace(',','.')); currency='EUR'; priceRaw=htmlPriceEUR[0]; }
      else if(htmlPriceUSD){ price = Number(htmlPriceUSD[1].replace(/,/g,'')); currency='USD'; priceRaw=htmlPriceUSD[0]; }
    }

    // Image
    let image = ldImage || $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content') || $('img').first().attr('src') || null;
    if(image && image.startsWith('//')) image='https:'+image;

    // Availability
    const bodyText = cleanText($('body').text()).toLowerCase();
    const htmlLower = html.toLowerCase();
    let available = true;
    let stockStatus = 'unknown';
    const outOfStockSignals = ['out of stock','sold out','currently unavailable','temporarily out of stock','non disponibile','esaurito','aktuell nicht verf','actuellement indisponible','agotado','non disponibile al momento','out-of-stock','sold-out'];
    const inStockSignals = ['add to bag','add to cart','aggiungi al carrello','ajouter au panier','in den warenkorb','añadir a la bolsa','add to basket'];
    if(outOfStockSignals.some(s=> bodyText.includes(s) || htmlLower.includes(s))){
      available=false; stockStatus='out_of_stock';
    } else if(inStockSignals.some(s=> bodyText.includes(s))){
      available=true; stockStatus='in_stock';
    } else if(ldAvailability){
      if(String(ldAvailability).toLowerCase().includes('outofstock') || String(ldAvailability).toLowerCase().includes('soldout')){ available=false; stockStatus='out_of_stock'; }
      else if(String(ldAvailability).toLowerCase().includes('instock')){ available=true; stockStatus='in_stock'; }
    }

    // Region restriction detection
    const restrictionPhrases = [
      'not available to ship','cannot be shipped','cannot ship to','does not ship to','shipping restriction','international shipping not available','not available in your region','not available in your country','cannot be delivered to','us only','united states only','excluded from international shipping','international shipping is not available for this item',
      'non può essere spedito','non disponibile per la spedizione internazionale','spedizione non disponibile','non spedibile in europa','non disponibile nel tuo paese','non disponibile nella tua regione','solo per gli stati uniti',
      'nicht lieferbar nach','kann nicht nach europa versendet werden','nicht für den internationalen versand verfügbar',
      'ne peut pas être expédié','non expédiable en europe','livraison internationale non disponible'
    ];
    let restricted = false;
    let restrictedMsg = null;
    for(const phrase of restrictionPhrases){
      if(bodyText.includes(phrase)){
        restricted=true;
        // extract snippet
        const idx = bodyText.indexOf(phrase);
        restrictedMsg = cleanText(bodyText.slice(Math.max(0,idx-40), idx+phrase.length+80));
        break;
      }
    }
    // also check if html contains shipping-restriction JSON
    if(!restricted && htmlLower.includes('shipping') && htmlLower.includes('restriction')){
      const m = html.match(/shipping[^<]{0,120}restriction[^<]{0,120}/i);
      if(m){ restricted=true; restrictedMsg=cleanText(m[0]); }
    }

    // Exclusive / limited edition detection
    let exclusive = false;
    let exclusiveLabel = null;
    const exclusivePhrases = ['limited edition','limited release','exclusively at','shopdisney exclusive','parks exclusive','disney parks exclusive','exclusif','edizione limitata','edicion limitada','limited-edition'];
    for(const p of exclusivePhrases){
      if(bodyText.includes(p)){
        exclusive=true;
        exclusiveLabel=p;
        break;
      }
    }

    // Not found detection
    const notFound = htmlLower.includes('page not found') || htmlLower.includes('404') && bodyText.includes('not found') || $('title').text().toLowerCase().includes('404') || bodyText.includes('oops!') && bodyText.includes('not found');

    // SKU / ID extraction
    let sku = ldSku || null;
    if(!sku){
      const skuMeta = $('meta[property="product:retailer_item_id"]').attr('content') || $('[data-sku]').attr('data-sku') || $('[data-product-id]').attr('data-product-id');
      if(skuMeta) sku=skuMeta;
    }
    if(!sku){
      const mSku = html.match(/["']sku["']\s*:\s*["']([^"']+)["']/i) || url.match(/(?:sku|product)[=\/]([^&\/\?]+)/i);
      if(mSku) sku=mSku[1];
    }

    return { url, title: cleanText(title)||'Prodotto Disney', price, currency, priceRaw, image, available, stockStatus, restricted, restrictedMsg, exclusive, exclusiveLabel, sku, notFound, htmlLength: html.length };
  }catch(e){
    return { url, title: null, price: null, currency: null, image: null, available: false, stockStatus:'error', restricted:false, restrictedMsg:null, exclusive:false, notFound:false, error:e.message, htmlLength: 0 };
  }
}

async function fetchDisneyWithCache(url){
  const key = url.toLowerCase();
  const cached = disneyCache.get(key);
  if(cached && Date.now()-cached.ts < DISNEY_TTL) return cached.data;
  let html=null;
  let status=null;
  let finalUrl=url;
  try{
    const res = await fetch(url, {
      headers: {
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language':'en-US,en;q=0.9,it;q=0.8,fr;q=0.7,de;q=0.6',
        'Referer':'https://www.shopdisney.com/',
        'Cache-Control':'no-cache'
      },
      redirect:'follow'
    });
    status=res.status;
    finalUrl=res.url||url;
    html= await res.text();
    // detect WAF / bot block
    const isBlock = html.includes('Access Denied') || html.includes('Akamai') && html.length<8000 || html.includes('Please enable cookies')|| html.includes('bot detection');
    if(isBlock) throw new Error('Blocco anti-bot Disney');
  }catch(e){
    // try with different UA
    try{
      const r2 = await fetchWithHeaders(url, {'Accept-Language':'en-US,en;q=0.9'});
      html=r2;
      status=200;
    }catch(e2){
      return { html: null, status: status||0, error: e.message+' | '+e2.message, finalUrl };
    }
  }
  const parsed = html ? parseDisneyProduct(html, finalUrl) : null;
  if(status===404 || (parsed && parsed.notFound)) parsed.notFound=true;
  const data = { html, status, finalUrl, parsed };
  disneyCache.set(key, { ts: Date.now(), data });
  return data;
}

function buildEUCandidates(inputUrl){
  try{
    const u = new URL(inputUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    let slug = u.searchParams.get('q') || path.split('/').filter(Boolean).pop() || '';
    slug = slug.replace(/\.html$/i,'');
    const isSearch = u.pathname.includes('/search');
    // Extract product name without numeric id
    const candidates=[];
    // 1) Direct host swap
    if(host.includes('shopdisney.com') || host.includes('disneystore.com')){
      candidates.push(`https://www.shopdisney.eu${path}${u.search}`);
      candidates.push(`https://www.shopdisney.co.uk${path}${u.search}`);
      candidates.push(`https://www.shopdisney.fr${path}${u.search}`);
      candidates.push(`https://www.shopdisney.de${path}${u.search}`);
      candidates.push(`https://www.disneystore.eu${path}${u.search}`);
      candidates.push(`https://www.disneystore.co.uk${path}${u.search}`);
      // search fallback
      const q = isSearch ? encodeURIComponent(slug) : encodeURIComponent(slug.replace(/-/g,' ').replace(/\d+/g,'').trim() || slug);
      if(!isSearch){
        candidates.push(`https://www.shopdisney.eu/search?q=${q}`);
        candidates.push(`https://www.shopdisney.co.uk/search?q=${q}`);
      }
    } else if(host.includes('disney')){
      // assume EU -> try US
      candidates.push(`https://www.shopdisney.com${path}${u.search}`);
      if(!isSearch){
        const q2 = encodeURIComponent(slug.replace(/-/g,' ').replace(/\d+/g,'').trim() || slug);
        candidates.push(`https://www.shopdisney.com/search?q=${q2}`);
      }
    }
    // also try without locale prefix (only if not already search)
    if(!isSearch) candidates.push(`https://www.shopdisney.eu/search?q=${encodeURIComponent(slug)}`);
    else candidates.push(`https://www.shopdisney.eu/search?q=${encodeURIComponent(slug)}`);
    return [...new Set(candidates)];
  }catch(e){ return []; }
}

function buildUSCandidates(inputUrl){
  try{
    const u = new URL(inputUrl);
    const path = u.pathname;
    let slug = u.searchParams.get('q') || path.split('/').filter(Boolean).pop() || '';
    slug = slug.replace(/\.html$/i,'');
    // for search URLs, keep original query as is, no dash removal
    const isSearch = u.pathname.includes('/search');
    const q = isSearch ? encodeURIComponent(slug) : encodeURIComponent(slug.replace(/-/g,' ').replace(/\d+/g,'').trim() || slug);
    const list=[];
    // direct
    list.push(`https://www.shopdisney.com${path}${u.search}`);
    // also try disneystore.com (new domain after migration)
    list.push(`https://www.disneystore.com${path}${u.search}`);
    // search fallbacks
    if(!isSearch){
      list.push(`https://www.shopdisney.com/search?q=${q}`);
      list.push(`https://www.disneystore.com/search?q=${q}`);
    }
    // if input was EU, try to reconstruct US path without locale
    if(slug && !isSearch) list.push(`https://www.shopdisney.com/search?q=${encodeURIComponent(slug)}`);
    else if(isSearch && slug) {
      // for search input, also try without path mangling
      list.push(`https://www.shopdisney.com/search?q=${encodeURIComponent(slug)}`);
      list.push(`https://www.disneystore.com/search?q=${encodeURIComponent(slug)}`);
    }
    return [...new Set(list)];
  }catch(e){ return []; }
}

function decideVerdict(us, eu){
  // us/eu are parsed objects or null
  const usFound = us && !us.notFound && us.title;
  const euFound = eu && !eu.notFound && eu.title;
  const usAvail = usFound && us.available && !us.restricted;
  const euAvail = euFound && eu.available && !eu.restricted;

  if(!usFound && !euFound) return { verdict:'NON_TROVATO', label:'Prodotto non trovato', color:'zinc', detail:'Nessun risultato valido su US né EU. Prova con un altro link o con il nome esatto.' };
  if(usFound && !euFound) {
    if(us.restricted) return { verdict:'LIMITATO_USA', label:'Limitato al mercato USA 🇺🇸', color:'amber', detail:'Trovato solo su shopDisney US. Assente su EU → probabile esclusiva USA / Parks / spedizione solo USA.' };
    if(!us.available) return { verdict:'US_ESCLUSIVO_ESAURITO', label:'Solo USA ma esaurito 🇺🇸', color:'amber', detail:'Esiste solo su US ma è out of stock. Su EU non esiste.' };
    return { verdict:'US_ESCLUSIVO', label:'Esclusiva USA 🇺🇸', color:'red', detail:'Disponibile solo su shopDisney US. Non trovato su EU → esclusiva mercato americano.' };
  }
  if(!usFound && euFound){
    if(eu.restricted) return { verdict:'LIMITATO_EU', label:'Limitato al mercato EU 🇪🇺', color:'blue', detail:'Trovato solo su EU. Assente su US.' };
    return { verdict:'EU_ESCLUSIVO', label:'Esclusiva EU 🇪🇺', color:'blue', detail:'Disponibile solo su mercato europeo.' };
  }
  // both found
  if(us.restricted && !eu.restricted) return { verdict:'BLOCCATO_US', label:'Bloccato per spedizione USA → EU', color:'amber', detail: us.restrictedMsg || 'US indica restrizione spedizione internazionale.' };
  if(eu.restricted && !us.restricted) return { verdict:'BLOCCATO_EU', label:'Bloccato EU', color:'amber', detail: eu.restrictedMsg || 'EU indica restrizione.' };
  if(!usAvail && euAvail) return { verdict:'SOLO_EU_DISPONIBILE', label:'Solo EU disponibile 🇪🇺', color:'blue', detail:'Su US è esaurito / non acquistabile, su EU è disponibile.' };
  if(usAvail && !euAvail) return { verdict:'SOLO_US_DISPONIBILE', label:'Solo US disponibile 🇺🇸', color:'amber', detail:'Su EU è esaurito / non acquistabile, su US è disponibile.' };
  if(usAvail && euAvail) {
    // price diff
    if(us.price && eu.price){
      const diff = Math.abs(us.price - eu.price);
      const sameCurrency = us.currency===eu.currency;
      if(!sameCurrency) return { verdict:'DISPONIBILE_ENTRAMBI', label:'Disponibile in entrambi i mercati ✅', color:'emerald', detail:`Disponibile sia US ($${us.price}) che EU (€${eu.price}). Prezzi in valute diverse.` };
      if(diff<1) return { verdict:'DISPONIBILE_ENTRAMBI', label:'Disponibile in entrambi i mercati ✅', color:'emerald', detail:`Disponibile sia US che EU a prezzo quasi identico (${us.currency} ${us.price} vs ${eu.price}).` };
      return { verdict:'DISPONIBILE_ENTRAMBI_PREZZO_DIVERSO', label:'Disponibile entrambi - prezzo diverso', color:'emerald', detail:`Disponibile in entrambi. US: ${us.currency} ${us.price} vs EU: ${eu.currency} ${eu.price}.` };
    }
    return { verdict:'DISPONIBILE_ENTRAMBI', label:'Disponibile in entrambi i mercati ✅', color:'emerald', detail:'Prodotto acquistabile sia su shopDisney US che EU.' };
  }
  return { verdict:'ENTRAMBI_NON_DISPONIBILI', label:'Trovato ma non disponibile', color:'zinc', detail:'Esiste su entrambi ma risulta non disponibile / esaurito.' };
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

// ---------------- Disney US vs EU API ----------------
async function disneyCheckHandler(targetUrlInput, res){
  let targetUrl = targetUrlInput;
  if(!targetUrl || !targetUrl.trim()) return res.status(400).json({ error: 'Parametro url o q mancante. Es: /api/disney/check?url=https://www.shopdisney.com/mickey-plush-123' });
  targetUrl = targetUrl.trim();
  if(!targetUrl.startsWith('http')){
    const encoded = encodeURIComponent(targetUrl);
    targetUrl = `https://www.shopdisney.com/search?q=${encoded}`;
  }
  let isDisneyLike = targetUrl.includes('shopdisney') || targetUrl.includes('disneystore') || targetUrl.includes('disney.com');
  const lowerUrl = targetUrl.toLowerCase();
  const isUSInput = (lowerUrl.includes('shopdisney.com') || lowerUrl.includes('disneystore.com')) && !lowerUrl.includes('shopdisney.eu') && !lowerUrl.includes('shopdisney.co.uk') && !lowerUrl.includes('shopdisney.fr') && !lowerUrl.includes('shopdisney.de') && !lowerUrl.includes('disneystore.eu') && !lowerUrl.includes('disneystore.co.uk');
  let usCandidates=[], euCandidates=[];
  try{
    if(isUSInput){
      usCandidates = [targetUrl, ...buildUSCandidates(targetUrl).slice(1)];
      euCandidates = buildEUCandidates(targetUrl);
    } else {
      euCandidates = [targetUrl];
      usCandidates = buildUSCandidates(targetUrl);
      const slug = (()=>{ try{ return new URL(targetUrl).searchParams.get('q') || new URL(targetUrl).pathname.split('/').filter(Boolean).pop() || ''; }catch(e){ return ''; }})();
      if(slug) euCandidates = [targetUrl, `https://www.shopdisney.eu/search?q=${encodeURIComponent(slug)}`, `https://www.disneystore.eu/search?q=${encodeURIComponent(slug)}`];
    }
  }catch(e){
    usCandidates=[targetUrl];
    euCandidates=buildEUCandidates(targetUrl);
  }
  let usRaw=null, euRaw=null, usResult=null, euResult=null;
  async function tryCandidates(list){
    const isSearch = (u)=> u.includes('/search?q=') || u.includes('/search?');
    for(const cand of list.slice(0,8)){
      try{
        const r = await fetchDisneyWithCache(cand);
        if(!r || !r.parsed) continue;
        if(isSearch(cand)){
          if(r.html){
            const $s = cheerio.load(r.html);
            // Try multiple selectors for disneystore/shopDisney new layout
            let firstLink = null;
            // 1) look for product tiles with data attributes
            firstLink = $s('a.product-tile[href], a[data-test*="product"][href], a.tile[href]').first().attr('href');
            // 2) look for any .html link with numeric ID (disneystore pattern: /xxx-123456789012.html)
            if(!firstLink){
              $s('a[href$=".html"]').each((i,el)=>{
                const h=$(el).attr('href');
                if(h && /\d{8,}\.html/.test(h) && !h.includes('disney-visa') && !h.includes('help') && !h.includes('account')){
                  firstLink=h;
                  return false;
                }
              });
            }
            // 3) fallback: any href containing /search result but is .html
            if(!firstLink){
              $s('a[href*=".html"]').each((i,el)=>{
                const h=$(el).attr('href');
                if(h && h.includes('.html') && h.length>10 && !h.includes('disney-visa')){
                  // avoid category pages like /toys-plush/ etc without ID, prefer those with id
                  if(h.split('/').pop().includes('-') && /\d/.test(h)) { firstLink=h; return false; }
                }
              });
            }
            if(firstLink){
              let abs = firstLink.startsWith('http') ? firstLink : (firstLink.startsWith('/') ? `https://${new URL(cand).hostname}${firstLink}` : `https://www.shopdisney.com/${firstLink}`);
              // clean url: remove query after .html? keep isProductSearch param ok but we want base
              try{ abs = abs.split('?')[0].split('#')[0]; if(!abs.endsWith('.html')) abs+='.html'; }catch(e){}
              // But original link may need params; keep original if it had ?isProductSearch
              if(firstLink.includes('?')) abs = firstLink.startsWith('http')? firstLink : `https://${new URL(cand).hostname}${firstLink}`;
              if(abs.startsWith('/')) abs = `https://${new URL(cand).hostname}${abs}`;
              if(abs.startsWith('//')) abs = 'https:'+abs;
              // ensure absolute
              if(!abs.startsWith('http')) abs = `https://www.disneystore.com${abs.startsWith('/')?'':'/'}${abs}`;
              const det = await fetchDisneyWithCache(abs);
              if(det && det.parsed && det.parsed.title && !det.parsed.notFound && !det.parsed.title.includes('Search Results')) return { r: det, cand: abs };
              // if detail is still search results, continue
            }
          }
          continue;
        }
        if(r.parsed && r.parsed.title && !r.parsed.notFound && !r.parsed.title.includes('Search Results') && r.parsed.title.length>3) return { r, cand };
        if(r.status===404) continue;
      }catch(e){}
    }
    // fallback: only if first cand is NOT a search page
    if(list[0] && !isSearch(list[0])){
      try{
        const r = await fetchDisneyWithCache(list[0]);
        // don't return search results as valid product
        if(r.parsed && r.parsed.title && r.parsed.title.includes('Search Results')) return null;
        return { r, cand:list[0]};
      }catch(e){ return null; }
    }
    return null;
  }
  const usTry = await tryCandidates(usCandidates);
  const euTry = await tryCandidates(euCandidates);
  usRaw = usTry?.r || null;
  euRaw = euTry?.r || null;
  usResult = usRaw?.parsed || null;
  euResult = euRaw?.parsed || null;
  const verdict = decideVerdict(usResult, euResult);
  res.json({
    input: targetUrl,
    us: usResult ? {
      url: usTry?.cand || usCandidates[0] || null,
      finalUrl: usRaw?.finalUrl || null,
      status: usRaw?.status || null,
      found: !!(usResult && !usResult.notFound && usResult.title),
      title: usResult.title || null,
      price: usResult.price || null,
      currency: usResult.currency || null,
      priceRaw: usResult.priceRaw || null,
      image: usResult.image || null,
      sku: usResult.sku || null,
      available: usResult.available,
      stockStatus: usResult.stockStatus,
      restricted: usResult.restricted,
      restrictedMsg: usResult.restrictedMsg,
      exclusive: usResult.exclusive,
      exclusiveLabel: usResult.exclusiveLabel
    } : { url: usCandidates[0]||null, found:false, error:'Non trovato su US' },
    eu: euResult ? {
      url: euTry?.cand || euCandidates[0] || null,
      finalUrl: euRaw?.finalUrl || null,
      status: euRaw?.status || null,
      found: !!(euResult && !euResult.notFound && euResult.title),
      title: euResult.title || null,
      price: euResult.price || null,
      currency: euResult.currency || null,
      priceRaw: euResult.priceRaw || null,
      image: euResult.image || null,
      sku: euResult.sku || null,
      available: euResult.available,
      stockStatus: euResult.stockStatus,
      restricted: euResult.restricted,
      restrictedMsg: euResult.restrictedMsg,
      exclusive: euResult.exclusive,
      exclusiveLabel: euResult.exclusiveLabel
    } : { url: euCandidates[0]||null, found:false, error:'Non trovato su EU' },
    verdict,
    candidates: { us: usCandidates, eu: euCandidates },
    cached: false
  });
}
app.get('/api/disney/check', async (req,res)=>{
  const rawUrl = (req.query.url||req.query.q||'').toString().trim();
  await disneyCheckHandler(rawUrl, res);
});
app.post('/api/disney/check', express.json({limit:'200kb'}), async (req,res)=>{
  const bodyUrl = (req.body.url||req.body.q||'').toString().trim();
  await disneyCheckHandler(bodyUrl, res);
});

app.get('/api/disney/parse', async (req,res)=>{
  const u = (req.query.url||'').toString().trim();
  if(!u) return res.status(400).json({error:'url mancante'});
  const r = await fetchDisneyWithCache(u);
  if(!r || !r.parsed) return res.status(404).json({error:'Impossibile parsare', status:r?.status});
  res.json(r.parsed);
});

// Sync automatico inventario tra locale e Vercel via GitHub
const DATA_PATH = path.join(__dirname, 'data', 'inventory.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'GIUREX97/brickfig-manager';

// Unione delle foto: non perdere MAI una foto reale. Se un lato ha gia gli
// indirizzi su disco (/data/photos/...) scartiamo i vecchi base64 duplicati.
function mergeFotoLists(a, b){
  const A = Array.isArray(a) ? a.filter(Boolean) : [];
  const B = Array.isArray(b) ? b.filter(Boolean) : [];
  const isUrl = (u) => typeof u === 'string' && u.indexOf('/data/photos/') === 0;
  const aUrl = A.some(isUrl), bUrl = B.some(isUrl);
  const out = [];
  const add = (list) => { for(const u of list){ if(u && out.indexOf(u) === -1) out.push(u); } };
  if(aUrl && !bUrl) add(A);
  else if(bUrl && !aUrl) add(B);
  else { add(A); add(B); }
  return out.slice(0, 5);
}

// Merge inventario locale/cloud senza perdere foto ne pezzi creati in locale.
function mergeInventory(localArr, remoteArr){
  const local = Array.isArray(localArr) ? localArr : [];
  const remote = Array.isArray(remoteArr) ? remoteArr : [];
  const map = new Map();
  for(const f of remote){ if(f && f.id) map.set(f.id, f); }
  for(const l of local){
    if(!l || !l.id) continue;
    const r = map.get(l.id);
    if(!r){ map.set(l.id, l); continue; }
    const base = (r.updated || 0) > (l.updated || 0) ? { ...l, ...r } : l;
    map.set(l.id, { ...base, fotoExtra: mergeFotoLists(l.fotoExtra, r.fotoExtra), foto: base.foto || l.foto || r.foto || '' });
  }
  return [...map.values()];
}

// ============================================================================
// FOTO REALI SU DISCO (fix 25-11-2026)
// Prima le foto venivano salvate come base64 dentro il localStorage del browser
// (~5MB max): quando era pieno il browser le scartava e al riavvio sparivano.
// Ora il file immagine vive su disco in data/photos e nel gestionale resta solo
// l'indirizzo corto (/data/photos/xxxx.jpg), quindi niente piu quota piena.
// ============================================================================
const PHOTOS_DIR = path.join(__dirname, 'data', 'photos');
try { fs.mkdirSync(PHOTOS_DIR, { recursive: true }); } catch(e){}

// Backup best-effort della foto anche sul repo GitHub (cosi si vede pure online).
// Se il token non e valido la foto resta comunque al sicuro in locale.
async function backupPhotoToGithub(name, buf){
  if(!GITHUB_TOKEN) return;
  try{
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/data/photos/${name}`;
    const headers = { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'brickfig-sync' };
    let sha = null;
    const get = await fetch(apiUrl, { headers });
    if(get.ok){ const j = await get.json(); sha = j.sha; }
    const put = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Foto reale ${name}`, content: buf.toString('base64'), sha: sha || undefined })
    });
    if(!put.ok){ const t = await put.text(); console.log('[foto] backup GitHub fallito:', put.status, t.slice(0,140)); }
  }catch(e){ console.log('[foto] backup GitHub errore:', e.message); }
}

app.post('/api/photo', express.json({ limit: '25mb' }), async (req, res) => {
  try{
    const dataUrl = req.body && req.body.data;
    if(typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return res.status(400).json({ error: 'Formato foto non valido' });
    const m = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/);
    if(!m) return res.status(400).json({ error: 'Base64 non valido' });
    let ext = String(m[1]).toLowerCase();
    if(ext === 'jpeg') ext = 'jpg';
    if(!['jpg','png','webp','gif','avif','bmp'].includes(ext)) ext = 'jpg';
    const buf = Buffer.from(m[2], 'base64');
    if(!buf.length) return res.status(400).json({ error: 'Foto vuota' });
    if(buf.length > 15*1024*1024) return res.status(413).json({ error: 'Foto troppo grande (max 15MB)' });
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0,16);
    const safe = String((req.body && req.body.filename) || '').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
    const name = hash + (safe ? '-' + safe : '') + '.' + ext;
    const filePath = path.join(PHOTOS_DIR, name);
    if(!fs.existsSync(filePath)) fs.writeFileSync(filePath, buf);
    // backup su GitHub in background: non blocchiamo la risposta
    backupPhotoToGithub(name, buf);
    res.json({ ok: true, url: '/data/photos/' + name, size: buf.length });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// Elenco foto presenti su disco (diagnostica)
app.get('/api/photos', (req, res) => {
  try{
    const files = fs.readdirSync(PHOTOS_DIR).filter(f => /\.(jpg|jpeg|png|webp|gif|avif|bmp)$/i.test(f));
    res.json({ count: files.length, dir: PHOTOS_DIR, files: files.slice(-200) });
  }catch(e){ res.json({ count: 0, error: e.message }); }
});

app.get('/api/sync', async (req, res) => {
  const readLocal = () => { try{ if(fs.existsSync(DATA_PATH)) return JSON.parse(fs.readFileSync(DATA_PATH,'utf8') || '[]'); }catch(e){} return []; };
  const saveMerged = (remoteArr) => {
    const merged = mergeInventory(readLocal(), remoteArr);
    try{ fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true }); fs.writeFileSync(DATA_PATH, JSON.stringify(merged, null, 2)); }catch(e){}
    return merged;
  };
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
          if (arr) return res.json(saveMerged(arr));
        }
      } catch(e){}
    }
    // 2) Fallback GitHub raw con cache-bust
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/inventory.json?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
      if (r.ok) {
        const j = await r.json();
        return res.json(saveMerged(j));
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

// === SOCIAL LINKS (Facebook / Vinted / eBay) - gestionale online ===
const SOCIAL_PATH = path.join(__dirname, 'data', 'social.json');
app.get('/api/social', async (req, res) => {
  try{
    if(GITHUB_TOKEN){
      try{
        const r=await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/social.json`, {headers:{Authorization:`token ${GITHUB_TOKEN}`,'User-Agent':'brickfig-sync','Cache-Control':'no-cache'}});
        if(r.ok){
          const j=await r.json();
          if(j.content){
            const dec=Buffer.from(j.content,'base64').toString('utf8');
            const arr=JSON.parse(dec||'{}');
            try{ fs.mkdirSync(path.dirname(SOCIAL_PATH),{recursive:true}); fs.writeFileSync(SOCIAL_PATH, JSON.stringify(arr,null,2)); }catch(e){}
            return res.json(arr);
          }
        }
      }catch(e){}
    }
    try{
      const r=await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/social.json?t=${Date.now()}`, {headers:{'Cache-Control':'no-cache'}});
      if(r.ok){ const j=await r.json(); try{fs.mkdirSync(path.dirname(SOCIAL_PATH),{recursive:true}); fs.writeFileSync(SOCIAL_PATH, JSON.stringify(j,null,2));}catch(e){} return res.json(j); }
    }catch(e){}
    if(fs.existsSync(SOCIAL_PATH)){ const j=JSON.parse(fs.readFileSync(SOCIAL_PATH,'utf8')||'{}'); return res.json(j); }
    res.json({facebook:'https://www.facebook.com/', vinted:'https://www.vinted.it/', ebay:'https://www.ebay.it/'});
  }catch(e){ res.json({facebook:'https://www.facebook.com/', vinted:'https://www.vinted.it/', ebay:'https://www.ebay.it/'}); }
});
app.post('/api/social', express.json({limit:'100kb'}), async (req,res)=>{
  const data=req.body;
  if(!data || typeof data!=='object') return res.status(400).json({error:'Formato non valido'});
  const clean={
    facebook: (data.facebook||'').toString().trim() || 'https://www.facebook.com/',
    vinted: (data.vinted||'').toString().trim() || 'https://www.vinted.it/',
    ebay: (data.ebay||'').toString().trim() || 'https://www.ebay.it/'
  };
  try{ fs.mkdirSync(path.dirname(SOCIAL_PATH),{recursive:true}); fs.writeFileSync(SOCIAL_PATH, JSON.stringify(clean,null,2)); }catch(e){}
  try{
    const getFile=await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/social.json`, {headers:{Authorization:`token ${GITHUB_TOKEN}`,'User-Agent':'brickfig-sync'}});
    let sha=null; if(getFile.ok){ const j=await getFile.json(); sha=j.sha; }
    const content=Buffer.from(JSON.stringify(clean,null,2)).toString('base64');
    const putRes=await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/social.json`, {
      method:'PUT',
      headers:{Authorization:`token ${GITHUB_TOKEN}`,'User-Agent':'brickfig-sync','Content-Type':'application/json'},
      body: JSON.stringify({message:`Update social links ${new Date().toISOString()}`, content, sha: sha||undefined})
    });
    if(!putRes.ok) console.log('GitHub social sync fallito:', (await putRes.text()).slice(0,200));
    else console.log('GitHub social sync OK');
  }catch(e){ console.log('GitHub social sync errore:', e.message); }
  res.json({ok:true, ...clean});
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
// Hotfix Vercel: serve output.css esplicitamente (file tracing @vercel/node non include root css altrimenti 404)
app.get('/output.css', (req,res)=>{
  res.setHeader('Content-Type','text/css; charset=utf-8');
  res.setHeader('Cache-Control','public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname,'output.css'), (err)=>{ if(err) res.status(404).send('/* output.css not found */'); });
});
app.get('/input.css', (req,res)=>{
  res.setHeader('Content-Type','text/css; charset=utf-8');
  res.sendFile(path.join(__dirname,'input.css'), (err)=>{ if(err) res.status(404).end(); });
});
app.get('/tailwind.js', (req,res)=>{
  res.setHeader('Cache-Control','public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname,'tailwind.js'), (err)=>{ if(err) res.status(404).end(); });
});
// Debug: lista file per verifica deploy
app.get('/api/debug-files', (req,res)=>{
  try{
    const files=fs.readdirSync(__dirname).filter(f=> f.endsWith('.css')||f.endsWith('.js')||f.endsWith('.html')).slice(0,20);
    const hasOutput=fs.existsSync(path.join(__dirname,'output.css'));
    res.json({dirname:__dirname, hasOutput, files, size: hasOutput? fs.statSync(path.join(__dirname,'output.css')).size:0});
  }catch(e){ res.json({error:e.message}); }
});

// === SPEDIZIONI USA-ITALIA - API PREVENTIVI & TELEGRAM ===
const QUOTES_PATH = path.join(__dirname, 'data', 'quotes.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
function readQuotes(){
  try{
    if(!fs.existsSync(QUOTES_PATH)) return [];
    return JSON.parse(fs.readFileSync(QUOTES_PATH,'utf8')||'[]');
  }catch(e){ return []; }
}
function writeQuotes(arr){
  try{ fs.mkdirSync(path.dirname(QUOTES_PATH),{recursive:true}); fs.writeFileSync(QUOTES_PATH, JSON.stringify(arr,null,2)); }catch(e){ console.log('writeQuotes error',e.message); }
}
function adminAuth(req,res,next){
  if(!ADMIN_PASSWORD) return next(); // no password = open
  const h = req.headers['authorization']||'';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  // token è base64 di password o password stessa per semplicità
  if(token === ADMIN_PASSWORD || token === Buffer.from(ADMIN_PASSWORD).toString('base64')) return next();
  return res.status(401).json({error:'Non autorizzato - password admin errata'});
}
app.post('/api/admin/login', (req,res)=>{
  const {password} = req.body||{};
  if(!ADMIN_PASSWORD){
    // senza password, login sempre ok, token= 'open'
    return res.json({ok:true, token:'open'});
  }
  if(password === ADMIN_PASSWORD) return res.json({ok:true, token: Buffer.from(ADMIN_PASSWORD).toString('base64')});
  return res.status(401).json({error:'Password errata'});
});
app.post('/api/preventivo-calcolo', (req,res)=>{
  try{
    const {direzione='USA->ITA', peso, lunghezza, larghezza, altezza, valore=0, servizio='priority', assicurazione=false, doganaInclusa=true} = req.body||{};
    const preventivo = calcolaPreventivo({direzione, peso, lunghezza, larghezza, altezza, valore, servizio, assicurazione, doganaInclusa});
    res.json(preventivo);
  }catch(e){ res.status(400).json({error:e.message}); }
});
app.post('/api/preventivi', async (req,res)=>{
  try{
    const {direzione, servizio, nome, cognome, email, telefono, cittaPartenza, capPartenza, statoPartenza, cittaArrivo, capArrivo, statoArrivo, peso, lunghezza, larghezza, altezza, valore, contenuto, assicurazione, doganaInclusa, note} = req.body||{};
    if(!nome || !email || !peso || !valore || !direzione) return res.status(400).json({error:'Campi obbligatori mancanti: nome, email, peso, valore, direzione'});
    if(!email.includes('@')) return res.status(400).json({error:'Email non valida'});
    const preventivo = calcolaPreventivo({direzione, peso, lunghezza, larghezza, altezza, valore, servizio: servizio||'priority', assicurazione: !!assicurazione, doganaInclusa: doganaInclusa!==false});
    const codice = generaCodicePreventivo();
    const quotes = readQuotes();
    const entry = {
      codice,
      direzione, servizio: servizio||'priority',
      nome: String(nome).trim(), cognome: String(cognome||'').trim(),
      email: String(email).trim().toLowerCase(), telefono: String(telefono||'').trim(),
      cittaPartenza: String(cittaPartenza||'').trim(), capPartenza: String(capPartenza||'').trim(), statoPartenza: String(statoPartenza||'').trim(),
      cittaArrivo: String(cittaArrivo||'').trim(), capArrivo: String(capArrivo||'').trim(), statoArrivo: String(statoArrivo||'').trim(),
      peso: Number(peso), lunghezza: lunghezza? Number(lunghezza): null, larghezza: larghezza? Number(larghezza): null, altezza: altezza? Number(altezza): null,
      valore: Number(valore), contenuto: String(contenuto||'').trim(),
      assicurazione: !!assicurazione, doganaInclusa: doganaInclusa!==false,
      note: String(note||'').trim(),
      preventivo,
      stato: 'nuovo',
      creatoIl: new Date().toISOString(),
      aggiornatoIl: null,
      prezzoFinale: null,
      tracking: null,
      noteInterna: null
    };
    quotes.push(entry);
    writeQuotes(quotes);
    // Notifica Telegram async (non blocca risposta)
    notifyNewQuote(entry, preventivo).catch(e=> console.log('notify error',e.message));
    // Email opzionale a admin (se configurata)
    try{
      const to = process.env.ADMIN_EMAIL;
      const pass = (process.env.GMAIL_APP_PASS||'').replace(/\s/g,'');
      const from = process.env.GMAIL_USER;
      if(to && pass && from){
        const nodemailer = (await import('nodemailer')).default;
        const transporter = nodemailer.createTransport({service:'gmail', auth:{user:from, pass}});
        const html = `<h2>📦 Nuovo preventivo ${codice}</h2><p><b>${entry.nome} ${entry.cognome}</b> • ${entry.email} • ${entry.telefono}</p><p><b>Direzione:</b> ${direzione} • <b>Servizio:</b> ${servizio} • <b>Peso:</b> ${peso}kg (fatt ${preventivo.pesoFatturabile}kg)</p><p><b>Da:</b> ${cittaPartenza} ${capPartenza} → <b>A:</b> ${cittaArrivo} ${capArrivo}</p><p><b>Valore:</b> €${valore} • <b>Contenuto:</b> ${contenuto}</p><p><b>Totale stimato: €${preventivo.totale.toFixed(2)}</b> (${preventivo.tempi.label})</p><p>Note: ${note||'-'}</p><p><a href="https://t.me/">Apri Telegram Bot</a> o gestisci da <a href="http://localhost:${PORT}/#admin">Area Admin</a></p>`;
        transporter.sendMail({from:`"Spedizioni USA-IT" <${from}>`, to, subject:`📦 Nuovo preventivo ${codice} - ${entry.nome} - ${direzione}`, html}).catch(()=>{});
      }
    }catch(e){}
    res.json({ok:true, codice, preventivo, stato:'nuovo'});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/preventivi', adminAuth, (req,res)=>{
  try{
    const filter = (req.query.filter||'tutte').toString();
    let quotes = readQuotes();
    if(filter !== 'tutte') quotes = quotes.filter(q=> q.stato===filter);
    res.json(quotes);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/preventivi/:codice', (req,res)=>{
  try{
    const codice = req.params.codice.toUpperCase();
    const quotes = readQuotes();
    const q = quotes.find(x=> x.codice.toUpperCase()===codice);
    if(!q) return res.status(404).json({error:'Preventivo non trovato'});
    // se non è admin, oscura email/telefono parzialmente? Per ora lascia ma tracking pubblico.
    res.json(q);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.patch('/api/preventivi/:codice/stato', adminAuth, async (req,res)=>{
  try{
    const codice = req.params.codice.toUpperCase();
    const {stato, noteInterna, tracking} = req.body||{};
    const allowed = ['nuovo','in_lavorazione','preventivo_inviato','accettato','spedito','consegnato','rifiutato','annullato'];
    if(!allowed.includes(stato)) return res.status(400).json({error:'Stato non valido'});
    const quotes = readQuotes();
    const idx = quotes.findIndex(x=> x.codice.toUpperCase()===codice);
    if(idx===-1) return res.status(404).json({error:'Non trovato'});
    quotes[idx].stato = stato;
    if(noteInterna!==undefined) quotes[idx].noteInterna = String(noteInterna);
    if(tracking!==undefined) quotes[idx].tracking = String(tracking);
    quotes[idx].aggiornatoIl = new Date().toISOString();
    writeQuotes(quotes);
    // Notifica telegram
    try{ await sendToAllAdmins(`🔄 <b>${codice}</b> → <b>${stato.toUpperCase()}</b>\nAggiornato da admin web`); }catch(e){}
    res.json({ok:true, quote: quotes[idx]});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/preventivi/:codice/prezzo', adminAuth, async (req,res)=>{
  try{
    const codice = req.params.codice.toUpperCase();
    const {prezzoFinale, nota} = req.body||{};
    if(!prezzoFinale || isNaN(prezzoFinale)) return res.status(400).json({error:'Prezzo finale mancante'});
    const quotes = readQuotes();
    const idx = quotes.findIndex(x=> x.codice.toUpperCase()===codice);
    if(idx===-1) return res.status(404).json({error:'Non trovato'});
    quotes[idx].prezzoFinale = Number(prezzoFinale);
    quotes[idx].stato = 'preventivo_inviato';
    quotes[idx].noteInterna = nota? String(nota) : `Prezzo finale confermato: €${Number(prezzoFinale).toFixed(2)}`;
    quotes[idx].aggiornatoIl = new Date().toISOString();
    writeQuotes(quotes);
    const q = quotes[idx];
    // Notifica cliente via email se possibile
    try{
      const to = q.email;
      const from = process.env.GMAIL_USER;
      const pass = (process.env.GMAIL_APP_PASS||'').replace(/\s/g,'');
      if(to && from && pass){
        const nodemailer = (await import('nodemailer')).default;
        const transporter = nodemailer.createTransport({service:'gmail', auth:{user:from, pass}});
        await transporter.sendMail({from:`"Spedizioni USA-IT" <${from}>`, to, subject:`Preventivo ${codice} - Prezzo confermato €${Number(prezzoFinale).toFixed(2)}`, html:`<p>Ciao ${q.nome},</p><p>Il prezzo finale per il tuo preventivo <b>${codice}</b> (${q.direzione}) è <b>€${Number(prezzoFinale).toFixed(2)}</b>.</p><p>${nota||''}</p><p>Rispondi a questa email per confermare.</p>`});
      }
    }catch(e){ console.log('email prezzo error',e.message); }
    try{ await sendToAllAdmins(`💶 <b>Prezzo finale</b> per <code>${codice}</code>: <b>€${Number(prezzoFinale).toFixed(2)}</b>\nInviato a ${q.email}`); }catch(e){}
    res.json({ok:true, quote: q});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/preventivi/:codice', adminAuth, (req,res)=>{
  try{
    const codice = req.params.codice.toUpperCase();
    let quotes = readQuotes();
    const before = quotes.length;
    quotes = quotes.filter(x=> x.codice.toUpperCase()!==codice);
    if(quotes.length===before) return res.status(404).json({error:'Non trovato'});
    writeQuotes(quotes);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/telegram/test', adminAuth, async (req,res)=>{
  const t = await testBot();
  res.json(t);
});
app.get('/api/telegram/admins', adminAuth, (req,res)=>{
  res.json({admins: getAdminIds()});
});
// Serve pagine spedizioni (nuovo sito separato - non tocca il gestionale LEGO)
app.get('/spedizioni', (req,res)=> res.sendFile(path.join(__dirname,'spedizioni.html')));
app.get('/spedizioni.html', (req,res)=> res.sendFile(path.join(__dirname,'spedizioni.html')));
app.get('/preventivo', (req,res)=> res.sendFile(path.join(__dirname,'spedizioni.html')));
app.get('/usa-italia', (req,res)=> res.sendFile(path.join(__dirname,'spedizioni.html')));
app.get('/brickfig.html', (req,res)=> res.sendFile(path.join(__dirname,'brickfig.html')));
app.get('/brickfig', (req,res)=> res.sendFile(path.join(__dirname,'brickfig.html')));
app.get('/gestionale', (req,res)=> res.sendFile(path.join(__dirname,'brickfig.html')));
// Disney US vs EU checker
app.get('/disney', (req,res)=> res.sendFile(path.join(__dirname,'disney.html')));
app.get('/disney.html', (req,res)=> res.sendFile(path.join(__dirname,'disney.html')));
app.get('/disney-check', (req,res)=> res.sendFile(path.join(__dirname,'disney.html')));
app.get('/disney-extension.zip', (req,res)=>{
  const zp = path.join(__dirname,'disney-extension.zip');
  if(fs.existsSync(zp)) res.sendFile(zp);
  else res.status(404).send('Estensione non ancora pacchettizzata - usa la cartella disney-extension/');
});
app.use('/disney-extension', express.static(path.join(__dirname,'disney-extension')));
// Fallback per SPA - RIPRISTINATO: gestionale LEGO originale su /
app.get('*', (req, res) => {
  if(req.path.startsWith('/api/')) return res.status(404).json({error:'API non trovata'});
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Avvio solo in locale - su Vercel esportiamo handler serverless
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🧱 BrickFig Manager Server avviato! (ripristinato originale)`);
    console.log(`📦 Gestionale LEGO: http://localhost:${PORT}  (index.html originale)`);
    console.log(`🚀 Nuovo sito spedizioni USA-Italia: http://localhost:${PORT}/spedizioni  (separato)`);
    console.log(`🔌 API Preventivi: http://localhost:${PORT}/api/preventivi`);
    console.log(`🔌 API BrickLink: http://localhost:${PORT}/api/bricklink?code=col001`);
    console.log(`\nPremi CTRL+C per fermare\n`);
    initTelegramBot();
  });
} else {
  initTelegramBot();
}

export default app;
