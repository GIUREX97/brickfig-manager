import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Cache in memoria per velocità
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 ore

function normalizeCode(input) {
  return input.trim().toLowerCase().replace(/\s+/g, '');
}

function detectType(code) {
  code = normalizeCode(code);
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
  return [...new Set(variants)];
}

function bricklinkImageUrl(code, type) {
  code = normalizeCode(code);
  if (type === 'P') return `https://img.bricklink.com/ItemImage/PN/0/${code}.png`;
  if (type === 'S') return `https://img.bricklink.com/ItemImage/SN/0/${code}.png`;
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
  // Override richiesto utente: colspi-11 deve dare il cowboy con cavallo (foto utente), non May Parker
  // Su BrickLink colspi11 è May, ma l'utente ha il cowboy come colspi-11, quindi mappiamo
  if (normalizeCode(rawCode) === 'colspi-11') {
    rawCode = 'colspi12';
  }
  let variants = getCodeVariants(rawCode);
  let type = forcedType || detectType(rawCode);
  let tryTypes;
  if (forcedType) tryTypes = [forcedType];
  else if (type === 'S') tryTypes = ['S','M','P'];
  else if (type === 'P') tryTypes = ['P','M','S'];
  else tryTypes = ['M','P','S'];
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
          tipo: tryType === 'P' ? 'Parte Sfusa' : tryType === 'S' ? 'Set Completo' : 'Minifigure',
          tipoCode: tryType,
          nome: fromBrickeconomy.nome || code.toUpperCase(),
          categoria: fromBrickeconomy.categoria || (tryType === 'P' ? 'Parts' : 'Minifigures'),
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
      // Estrae tutte le varianti colore per parti come 6026c01 (PN/6 verde, PN/10 grigio, PN/80 verde scuro)
      const colorImgs = [...html.matchAll(/ItemImage\/P[NT]\/(\d+)\/[^'"]+\.png/g)].map(m => m[0]);
      const uniqColors = [...new Set(colorImgs.map(p => p.match(/\/(\d+)\//)?.[1]).filter(Boolean))];
      // Costruisci lista varianti colore con URL e nome colore approssimativo
      const colorMap = { '0':'Multi', '1':'White', '2':'Tan', '3':'Green', '4':'Red', '5':'Red', '6':'Green', '7':'Light Gray','10':'Light Gray','11':'Black','12':'Trans-Clear','14':'Trans-Dark Blue','15':'White','21':'Chrome Gold','22':'Chrome Silver','26':'Black','34':'Lime','57':'Chrome Antique Brass','59':'Dark Red','80':'Dark Green','85':'Dark Bluish Gray','86':'Light Bluish Gray','88':'Reddish Brown','122':'Chrome Black','150':'Light Nougat','48':'Sand Green' };
      fotoVarianti = uniqColors.map(c => ({
        colorId: c,
        colorName: colorMap[c] || `Colore ${c}`,
        thumb: `https://img.bricklink.com/ItemImage/PT/${c}/${code}.t1.png`,
        image: `https://img.bricklink.com/ItemImage/PN/${c}/${code}.png`
      }));
      // Se non trovate varianti, usa foto principale
      if (fotoVarianti.length === 0 && foto) {
        const m = foto.match(/\/PN\/(\d+)\//);
        if (m) fotoVarianti.push({ colorId: m[1], colorName: colorMap[m[1]]||`Colore ${m[1]}`, thumb: foto.replace('/PN/','/PT/').replace('.png','.t1.png'), image: foto });
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
        tipo: tryType === 'P' ? 'Parte Sfusa' : 'Minifigure',
        tipoCode: tryType,
        nome,
        categoria,
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
  throw globalLastError || new Error(`Codice ${rawCode} non trovato su BrickLink. Varianti provate: ${variants.join(', ')}`);
}

app.get('/api/bricklink', async (req, res) => {
  const code = (req.query.code || '').toString().trim();
  const type = (req.query.type || '').toString().toUpperCase(); // M o P o vuoto
  const color = (req.query.color || '').toString().trim();
  if (!code) return res.status(400).json({ error: 'Parametro code mancante. Es: ?code=col001 o ?code=3001' });
  const forcedType = type === 'M' || type === 'P' ? type : null;
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
    // Prova prima GitHub raw (fonte di verità per Vercel)
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/inventory.json`, { headers: { 'Cache-Control': 'no-cache' } });
      if (r.ok) {
        const j = await r.json();
        // Sincronizza anche locale
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

// Fallback per SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🧱 BrickFig Manager Server avviato!`);
  console.log(`📦 Gestionale: http://localhost:${PORT}`);
  console.log(`🔌 API BrickLink: http://localhost:${PORT}/api/bricklink?code=col001`);
  console.log(`   Esempi: /api/bricklink?code=sw1159  /api/bricklink?code=3001&type=P`);
  console.log(`\nPremi CTRL+C per fermare\n`);
});
