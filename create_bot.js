import { TelegramClient } from "telegram";
import { StoreSession } from "telegram/sessions/index.js";
import readline from "readline";

const apiId = 2040;
const apiHash = "b18441a1ff607e10a989891a5462e627";
const session = new StoreSession("C:/Temp/tdata");

async function main(){
  console.log("Connessione con tdata...");
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => {
      // Prova a ottenere il numero dal client già loggato
      return "";
    },
    password: async () => {
      return "";
    },
    phoneCode: async () => {
      return "";
    },
    onError: (err) => console.log("Errore:", err),
  });
  console.log("Connesso! Username:", await client.getMe().then(m=>m.username));
  // Invia /newbot a BotFather
  const botFather = await client.getEntity("@BotFather");
  await client.sendMessage(botFather, { message: "/newbot" });
  console.log("Inviato /newbot, attendi risposta...");
  // Attendi risposta
  setTimeout(async ()=>{
    const msgs = await client.getMessages(botFather, { limit: 5 });
    msgs.forEach(m=> console.log("BotFather:", m.message));
    await client.disconnect();
  }, 5000);
}

main().catch(e=>{ console.error(e); process.exit(1); });
