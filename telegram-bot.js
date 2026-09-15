import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const ADMIN_IDS_RAW = process.env.TELEGRAM_ADMIN_IDS || process.env.ADMIN_IDS || ''; // comma separated
const ADMIN_CHAT_IDS_FILE = path.join(__dirname, 'data', 'telegram_admins.json');
const QUOTES_FILE = path.join(__dirname, 'data', 'quotes.json');

function loadAdminIds(){
  let ids = ADMIN_IDS_RAW.split(',').map(s=>s.trim()).filter(Boolean);
  try{
    if(fs.existsSync(ADMIN_CHAT_IDS_FILE)){
      const j = JSON.parse(fs.readFileSync(ADMIN_CHAT_IDS_FILE,'utf8')||'[]');
      if(Array.isArray(j)) ids = [...ids, ...j.map(String)];
    }
  }catch(e){}
  return [...new Set(ids.filter(Boolean))];
}
function saveAdminId(chatId){
  try{
    fs.mkdirSync(path.dirname(ADMIN_CHAT_IDS_FILE),{recursive:true});
    let arr=[];
    if(fs.existsSync(ADMIN_CHAT_IDS_FILE)) arr = JSON.parse(fs.readFileSync(ADMIN_CHAT_IDS_FILE,'utf8')||'[]');
    const s = String(chatId);
    if(!arr.includes(s)) arr.push(s);
    fs.writeFileSync(ADMIN_CHAT_IDS_FILE, JSON.stringify(arr,null,2));
    return arr;
  }catch(e){ return []; }
}
function removeAdminId(chatId){
  try{
    if(!fs.existsSync(ADMIN_CHAT_IDS_FILE)) return [];
    let arr=JSON.parse(fs.readFileSync(ADMIN_CHAT_IDS_FILE,'utf8')||'[]');
    arr = arr.filter(x=> String(x)!==String(chatId));
    fs.writeFileSync(ADMIN_CHAT_IDS_FILE, JSON.stringify(arr,null,2));
    return arr;
  }catch(e){ return []; }
}

let offset = 0;
let polling = false;
let botInfo = null;

async function tgApi(method, body=null){
  if(!BOT_TOKEN) throw new Error('BOT_TOKEN mancante');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const opts = { method: body ? 'POST':'GET', headers: {'Content-Type':'application/json'} };
  if(body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const j = await r.json();
  if(!j.ok) throw new Error(j.description||'Telegram API error');
  return j.result;
}

export async function sendMessage(chatId, text, extra={}){
  if(!BOT_TOKEN) { console.log('[Telegram] skip send (no token):', text.slice(0,120)); return null; }
  try{
    return await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }catch(e){ console.log('[Telegram] sendMessage error', e.message); return null; }
}

export async function sendToAllAdmins(text, extra={}){
  const ids = loadAdminIds();
  if(!ids.length){ console.log('[Telegram] nessun admin configurato, skip broadcast'); return; }
  for(const id of ids){
    await sendMessage(id, text, extra);
  }
}

export function formatQuoteNotification(q, preventivo){
  const dir = q.direzione==='USA->ITA' ? '🇺🇸 → 🇮🇹 <b>USA → Italia</b>' : '🇮🇹 → 🇺🇸 <b>Italia → USA</b>';
  const svc = q.servizio==='express' ? '⚡ Express' : q.servizio==='economy' ? '🐢 Economy' : '✈️ Priority';
  let t = `📦 <b>NUOVO PREVENTIVO</b> <code>${q.codice}</code>\n`;
  t+= `${dir} • ${svc}\n`;
  t+= `━━━━━━━━━━━━━━━\n`;
  t+= `👤 <b>Cliente:</b> ${q.nome} ${q.cognome||''}\n`;
  t+= `📧 ${q.email} • 📱 ${q.telefono||'-'}\n`;
  t+= `📍 <b>Da:</b> ${q.cittaPartenza||''} ${q.capPartenza||''} (${q.statoPartenza|| (q.direzione==='USA->ITA'?'USA':'Italia')})\n`;
  t+= `📍 <b>A:</b> ${q.cittaArrivo||''} ${q.capArrivo||''} (${q.statoArrivo|| (q.direzione==='USA->ITA'?'Italia':'USA')})\n`;
  t+= `━━━━━━━━━━━━━━━\n`;
  t+= `⚖️ Peso: ${q.peso}kg (fatturabile ${preventivo.pesoFatturabile}kg, vol ${preventivo.volumetrico}kg)\n`;
  t+= `📐 ${q.lunghezza||'-'}×${q.larghezza||'-'}×${q.altezza||'-'} cm\n`;
  t+= `💰 Valore merce: €${Number(q.valore||0).toFixed(2)}\n`;
  t+= `📝 Contenuto: ${q.contenuto||'-'}\n`;
  if(q.note) t+= `🗒 Note: ${q.note}\n`;
  t+= `━━━━━━━━━━━━━━━\n`;
  t+= `💶 <b>Totale stimato: €${preventivo.totale.toFixed(2)}</b> (${preventivo.tempi.label})\n`;
  t+= `   └ subtotale €${preventivo.subtotale.toFixed(2)} + ass. €${preventivo.extraAssicurazione.toFixed(2)} + dogana €${preventivo.extraDogana.toFixed(2)}\n`;
  if(preventivo.stimaDazi) t+= `⚠️ Stima dazi extra (se >€150): ~€${preventivo.stimaDazi}\n`;
  t+= `\n🔗 Gestisci su: /preventivi`;
  return t;
}

export function inlineKeyboardForQuote(codice){
  return {
    reply_markup: {
      inline_keyboard: [
        [{text:'✅ Accetta', callback_data:`accetta:${codice}`}, {text:'💬 Contatta', callback_data:`contatta:${codice}`}],
        [{text:'📄 Invia prezzo finale', callback_data:`prezzo:${codice}`}, {text:'❌ Rifiuta', callback_data:`rifiuta:${codice}`}],
        [{text:'📦 Segna come spedito', callback_data:`spedito:${codice}`}]
      ]
    }
  };
}

async function handleCommand(msg){
  const chatId = msg.chat.id;
  const text = (msg.text||'').trim();
  const from = msg.from;
  const username = from.username ? `@${from.username}` : `${from.first_name||''}`;
  if(text==='/start'){
    await sendMessage(chatId,
      `👋 Ciao ${from.first_name||''}!\n\n`+
      `Sono il bot <b>Spedizioni USA-Italia</b> 📦🇺🇸🇮🇹\n`+
      `Qui ricevi tutti i preventivi del sito e puoi gestirli in 2.\n\n`+
      `<b>Comandi admin:</b>\n`+
      `/admin - registrati come admin (riceverai i preventivi)\n`+
      `/admin_list - vedi admin registrati\n`+
      `/remove_admin - rimuoviti\n`+
      `/preventivi - ultimi 5 preventivi\n`+
      `/help - aiuto\n\n`+
      `<b>Condivisione:</b> inoltra questo bot al tuo socio e fagli fare /admin — riceverete entrambi le stesse notifiche nello stesso bot.\n`+
      `Oppure crea un <b>gruppo Telegram</b> con voi due + il bot, e fate /admin nel gruppo.`
    );
    return;
  }
  if(text==='/admin' || text.startsWith('/admin ')){
    const ids = loadAdminIds();
    saveAdminId(chatId);
    await sendMessage(chatId, `✅ <b>Registrato come admin!</b>\nChat ID: <code>${chatId}</code> (${msg.chat.type})\nOra riceverai tutti i nuovi preventivi qui.\n\nAdmin totali: ${ids.length+1}\nCondividi il bot con il tuo socio: @${botInfo?.username||'questo_bot'} e fagli fare /admin.`);
    // avvisa altri admin
    for(const id of ids){
      if(String(id)!==String(chatId)) await sendMessage(id, `👥 Nuovo admin registrato: ${username} (chat ${chatId}, tipo ${msg.chat.type})`);
    }
    return;
  }
  if(text==='/remove_admin'){
    removeAdminId(chatId);
    await sendMessage(chatId, `🗑 Rimosso dagli admin: ${chatId}`);
    return;
  }
  if(text==='/admin_list'){
    const ids = loadAdminIds();
    await sendMessage(chatId, `👥 <b>Admin registrati:</b>\n${ids.map(id=>`• <code>${id}</code>`).join('\n')||'(nessuno)'} \n\nTotale: ${ids.length}`);
    return;
  }
  if(text.startsWith('/preventivi')){
    try{
      const quotes = fs.existsSync(QUOTES_FILE) ? JSON.parse(fs.readFileSync(QUOTES_FILE,'utf8')||'[]') : [];
      const last = quotes.slice(-5).reverse();
      if(!last.length) { await sendMessage(chatId, '📭 Nessun preventivo ancora.'); return; }
      let out = `📋 <b>Ultimi ${last.length} preventivi:</b>\n\n`;
      for(const q of last){
        out += `<code>${q.codice}</code> • ${q.direzione} • ${q.nome} • €${(q.preventivo?.totale||0).toFixed(2)} • <i>${q.stato}</i>\n`;
      }
      out += `\nUsa i pulsanti sotto un preventivo per gestirlo, o scrivi:\n/accetta CODICE\n/rifiuta CODICE`;
      await sendMessage(chatId, out);
    }catch(e){ await sendMessage(chatId, 'Errore lettura preventivi: '+e.message); }
    return;
  }
  if(text.startsWith('/accetta')){
    const codice = text.split(/\s+/)[1];
    if(!codice) { await sendMessage(chatId, 'Uso: /accetta CODICE (es. /accetta PREV-2609ABCD)'); return; }
    await updateQuoteStatus(codice, 'accettato', chatId, username);
    return;
  }
  if(text.startsWith('/rifiuta')){
    const codice = text.split(/\s+/)[1];
    if(!codice) { await sendMessage(chatId, 'Uso: /rifiuta CODICE'); return; }
    await updateQuoteStatus(codice, 'rifiutato', chatId, username);
    return;
  }
  if(text==='/help'){
    await sendMessage(chatId,
      `<b>Help Bot Spedizioni</b>\n\n`+
      `/start - benvenuto\n`+
      `/admin - registrati\n`+
      `/admin_list - lista admin\n`+
      `/preventivi - lista ultimi\n`+
      `/accetta CODICE - accetta\n`+
      `/rifiuta CODICE - rifiuta\n\n`+
      `I preventivi arrivano automatici con pulsanti inline. Clicca per aggiornare lo stato.\n`+
      `Ogni admin che preme un pulsante notifica l'altro admin.`
    );
    return;
  }
  // default: se è admin, inoltra? else help
  const ids = loadAdminIds();
  if(ids.includes(String(chatId))){
    await sendMessage(chatId, `❓ Comando non riconosciuto.\nScrivi /help per la lista.`);
  } else {
    await sendMessage(chatId, `👋 Per ricevere i preventivi, scrivi /admin`);
  }
}

async function handleCallback(query){
  const data = query.data||'';
  const [action, codice] = data.split(':');
  const fromName = query.from.username ? `@${query.from.username}` : query.from.first_name;
  const chatId = query.message.chat.id;
  if(!codice) return;
  if(action==='accetta') await updateQuoteStatus(codice,'accettato', chatId, fromName, query.id);
  else if(action==='rifiuta') await updateQuoteStatus(codice,'rifiutato', chatId, fromName, query.id);
  else if(action==='spedito') await updateQuoteStatus(codice,'spedito', chatId, fromName, query.id);
  else if(action==='contatta'){
    try{ await tgApi('answerCallbackQuery',{callback_query_id: query.id, text: `Contatta il cliente di ${codice}`}); }catch(e){}
    // carica quote per mostrare contatti
    try{
      const quotes = JSON.parse(fs.readFileSync(QUOTES_FILE,'utf8')||'[]');
      const q = quotes.find(x=>x.codice===codice);
      if(q) await sendMessage(chatId, `📞 <b>Contatti ${codice}</b>\n👤 ${q.nome} ${q.cognome||''}\n📧 ${q.email}\n📱 ${q.telefono||'-'}\n\nScrivi al cliente e poi aggiorna lo stato con i pulsanti.`);
    }catch(e){}
    return;
  }
  else if(action==='prezzo'){
    try{ await tgApi('answerCallbackQuery',{callback_query_id: query.id, text: `Rispondi con prezzo finale per ${codice}`}); }catch(e){}
    await sendMessage(chatId, `💶 Per inviare il prezzo finale a <code>${codice}</code>, rispondi in chat con:\n<code>/prezzo ${codice} 123.50</code> (esempio)`);
    return;
  }
}

async function updateQuoteStatus(codice, nuovoStato, actorChatId, actorName, callbackId=null){
  try{
    if(!fs.existsSync(QUOTES_FILE)) return;
    let quotes = JSON.parse(fs.readFileSync(QUOTES_FILE,'utf8')||'[]');
    const idx = quotes.findIndex(q=>q.codice===codice);
    if(idx===-1){
      if(callbackId) try{ await tgApi('answerCallbackQuery',{callback_query_id: callbackId, text: 'Preventivo non trovato'});}catch(e){}
      await sendMessage(actorChatId, `❌ Preventivo <code>${codice}</code> non trovato.`);
      return;
    }
    const old = quotes[idx].stato;
    quotes[idx].stato = nuovoStato;
    quotes[idx].aggiornatoDa = actorName;
    quotes[idx].aggiornatoIl = new Date().toISOString();
    fs.writeFileSync(QUOTES_FILE, JSON.stringify(quotes,null,2));
    if(callbackId) try{ await tgApi('answerCallbackQuery',{callback_query_id: callbackId, text: `Stato: ${old} → ${nuovoStato}`});}catch(e){}
    const msg = `🔄 <b>Stato aggiornato</b> <code>${codice}</code>\n${old} → <b>${nuovoStato.toUpperCase()}</b>\n👤 da ${actorName} (chat ${actorChatId})`;
    await sendToAllAdmins(msg);
    // se c'è email cliente, potremmo notificare (gestito da server via email/telegram client)
    console.log(`[Telegram] ${codice}: ${old} -> ${nuovoStato} by ${actorName}`);
  }catch(e){ console.log('[Telegram] update status error', e.message); }
}

async function pollOnce(){
  if(!BOT_TOKEN) return;
  try{
    const updates = await tgApi('getUpdates', { offset, timeout: 0, allowed_updates: ['message','callback_query'] });
    for(const u of updates){
      offset = u.update_id + 1;
      if(u.message) await handleCommand(u.message);
      else if(u.callback_query) await handleCallback(u.callback_query);
      // salva offset persist? teniamo in memoria + file per restart
      try{ fs.writeFileSync(path.join(__dirname,'data','tg_offset.json'), JSON.stringify({offset})); }catch(e){}
    }
  }catch(e){
    if(!e.message.includes('409')) console.log('[Telegram] poll error', e.message);
    await new Promise(r=>setTimeout(r, 2000));
  }
}

export async function initTelegramBot(){
  if(!BOT_TOKEN){
    console.log('[Telegram] BOT_TOKEN non configurato - bot disattivato. Imposta TELEGRAM_BOT_TOKEN in .env per attivarlo.');
    return;
  }
  try{
    botInfo = await tgApi('getMe');
    console.log(`[Telegram] Bot connesso: @${botInfo.username} (${botInfo.first_name})`);
    // ripristina offset se esiste
    try{
      const o = JSON.parse(fs.readFileSync(path.join(__dirname,'data','tg_offset.json'),'utf8')||'{}');
      if(o.offset) offset = o.offset;
    }catch(e){}
    if(polling) return;
    polling = true;
    // avvia loop polling
    (async function loop(){
      while(polling){
        await pollOnce();
        await new Promise(r=>setTimeout(r, 800));
      }
    })();
  }catch(e){
    console.log('[Telegram] init error', e.message);
  }
}

export function getAdminIds(){ return loadAdminIds(); }
export async function notifyNewQuote(q, preventivo){
  if(!BOT_TOKEN) return;
  const text = formatQuoteNotification(q, preventivo);
  const kb = inlineKeyboardForQuote(q.codice);
  const ids = loadAdminIds();
  if(!ids.length){
    console.log('[Telegram] nessun admin - notifica non inviata. Usa /admin nel bot per registrarti.');
    return;
  }
  for(const id of ids){
    await sendMessage(id, text, kb);
  }
}

export async function testBot(){
  if(!BOT_TOKEN) return {ok:false, error:'BOT_TOKEN mancante'};
  try{
    const me = await tgApi('getMe');
    return {ok:true, bot: me, admins: loadAdminIds()};
  }catch(e){ return {ok:false, error: e.message}; }
}
