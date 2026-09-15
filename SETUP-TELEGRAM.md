# 📦 Spedizioni USA-Italia — Setup Bot Telegram condiviso (2 admin)

Il sito è già online e funzionante su `http://localhost:3000` (o su Vercel).  
Il bot Telegram è il canale ufficiale per gestire preventivi in **2 persone contemporaneamente**.

## Come funziona la condivisione a 2?

- **Un solo bot**, due admin.
- Ogni nuovo preventivo dal sito arriva **a entrambi** con pulsanti inline: ✅ Accetta • 💬 Contatta • 📄 Prezzo • ❌ Rifiuta
- Se uno dei due clicca, l'altro riceve la notifica di aggiornamento stato.
- Funziona anche se create un **gruppo Telegram con voi due + il bot**: stessa logica nel gruppo.

---

## Setup in 3 minuti

### 1) Crea il bot su Telegram
1. Apri Telegram → cerca `@BotFather` (verificato)
2. Invia `/newbot`
3. Scegli **nome visualizzato**: es. `Spedizioni USA-Italia`
4. Scegli **username** (deve finire con `bot`): es. `usa_italia_sped_bot`
5. Copia il **token** che ti restituisce, tipo: `1234567890:AAHabc...`

### 2) Inserisci il token nel server

**In locale (Windows):**
- Apri il file `.env` nella cartella del progetto (`C:\Users\gsimo\OneDrive\Documenti\Default Project\.env`)
- Aggiungi/modifica questa riga:

```
TELEGRAM_BOT_TOKEN=1234567890:AAHabcIlTuoTokenQui
TELEGRAM_ADMIN_IDS=
```

- Salva e riavvia il server: doppio click su `avvia-gestionale.bat` oppure `npm start` da PowerShell

**Su Vercel (se deployato):**
- Vai su Vercel Dashboard → Project → Settings → Environment Variables
- Aggiungi `TELEGRAM_BOT_TOKEN` = il tuo token
- Redeploy

### 3) Registra i 2 admin
1. Su Telegram cerca il tuo bot (username scelto) → `Avvia` o invia `/start`
2. Invia `/admin` → riceverai `✅ Registrato come admin!`
3. **Condividi il link del bot al tuo socio** (es. `https://t.me/usa_italia_sped_bot`)
4. Anche lui fa `/start` → `/admin` → ora siete entrambi registrati
5. Da questo momento ogni preventivo arriva a entrambi!

**Alternativa gruppo:**
- Crea gruppo Telegram con tu + socio + bot
- Nel gruppo inviate `/admin` → le notifiche arriveranno nel gruppo

### Verifica

- Nel sito: vai su `Area Admin` (in alto a destra) → `Test bot` → deve dire `✅ Bot @username ok`
- Oppure fai un preventivo di prova sul sito → deve arrivare a entrambi

---

## Comandi Bot

- `/start` — benvenuto + istruzioni
- `/admin` — registrati come admin (ricevi notifiche)
- `/admin_list` — vedi admin registrati
- `/remove_admin` — rimuoviti
- `/preventivi` — ultimi 5 preventivi
- `/accetta CODICE` — accetta manualmente
- `/rifiuta CODICE` — rifiuta
- Pulsanti inline sotto ogni notifica — più comodi

---

## Gestione preventivi dal sito

- **Area Admin** su `http://localhost:3000` → login (se `ADMIN_PASSWORD` vuota, basta `Entra` senza password)
- Puoi cambiare stato, inviare prezzo finale (notifica via email + Telegram), eliminare.
- Tracking pubblico: il cliente può inserire il codice `PREV-...` nella sezione `Traccia spedizione`

---

## Sicurezza

- Se vuoi proteggere l'area admin, imposta in `.env`:
```
ADMIN_PASSWORD=unaPasswordSegreta
```
Poi login richiederà quella password.

- Il bot è polling (no webhook), funziona sia in locale che su Vercel (su Vercel il polling continua finché la funzione è attiva; per produzione stabile considera un worker esterno o webhook).

---

## Tariffe

Vedi `spedizioni-logic.js` per modificare scaglioni, base fee €22, handling doganale €18, assicurazione 2% min €8, supplemento ITA→USA +6%, moltiplicatori servizio.

---

## File importanti

- `spedizioni.html` + `index.html` — frontend sito spedizioni
- `spedizioni-logic.js` — calcolo tariffe
- `telegram-bot.js` — logica bot condiviso
- `server.js` — API `/api/preventivi/*`, `/api/telegram/*`
- `data/quotes.json` — database preventivi
- `data/telegram_admins.json` — lista chat ID admin
- `brickfig.html` — vecchio gestionale LEGO (ora su `/brickfig`)

Fatto! 🚀
