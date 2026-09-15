// Helper per creare/configurare il bot Telegram delle spedizioni
// Uso: node crea-bot-spedizioni.js
import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q)=> new Promise(r=> rl.question(q, ans=> r(ans)));

console.log(`
📦 Spedizioni USA-Italia — Setup Bot Telegram condiviso (2 admin)
=====================================================================
Ti guido a creare il bot in 2 minuti.

Se hai già il token di @BotFather, incollalo qui.
Altrimenti premi INVIO e ti spiego come crearlo.
`);

let token = await ask('🔑 Token BotFather (es. 123456:AAH... ) [INVIO per guida]: ');
token = token.trim();

if(!token){
  console.log(`
📝 COME CREARE IL BOT:
1) Apri Telegram → cerca @BotFather (spunta blu)
2) Invia /newbot
3) Nome:  Spedizioni USA Italia
4) Username: scegli uno libero che finisce con bot (es. usa_italia_sped_bot)
5) Copia il token che ti dà (tipo 1234567890:AAH...)

Poi torna qui e incolla il token.
`);
  token = await ask('🔑 Incolla qui il token: ');
  token = token.trim();
  if(!token){
    console.log('❌ Nessun token inserito. Uscita.');
    process.exit(0);
  }
}

// valida token
if(!/^\d+:[\w\-]+$/.test(token)){
  console.log('⚠️ Token sembra non valido (formato atteso: 123456:AAH...)');
  const cont = await ask('Continuare comunque? (s/N): ');
  if(cont.toLowerCase()!=='s') process.exit(0);
}

// salva in .env
const envPath = path.join(process.cwd(), '.env');
let env = '';
try{ env = fs.readFileSync(envPath,'utf8'); }catch(e){ env=''; }
if(env.includes('TELEGRAM_BOT_TOKEN=')){
  env = env.replace(/TELEGRAM_BOT_TOKEN=.*/, `TELEGRAM_BOT_TOKEN=${token}`);
} else {
  env += `\nTELEGRAM_BOT_TOKEN=${token}\n`;
}
fs.writeFileSync(envPath, env);
console.log(`✅ Token salvato in .env`);

// verifica bot
console.log('🔍 Verifico token con Telegram...');
try{
  const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const j = await r.json();
  if(!j.ok) throw new Error(j.description);
  console.log(`✅ Bot verificato: @${j.result.username} (${j.result.first_name})`);
  console.log(`   Link per condividerlo col socio: https://t.me/${j.result.username}`);
  console.log(`
📌 PROSSIMI PASSI:
1) Riavvia il server:  npm start  (o doppio click su avvia-gestionale.bat)
2) Su Telegram → cerca @${j.result.username} → /start → /admin
3) Condividi https://t.me/${j.result.username} al tuo socio → anche lui /admin
4) Da ora ogni preventivo arriva a entrambi! Prova con un preventivo sul sito.

Area Admin web: http://localhost:3000  → "Area Admin" in alto a destra
`);
} catch(e){
  console.log(`❌ Verifica fallita: ${e.message}`);
  console.log('Controlla il token e riprova.');
}
rl.close();
