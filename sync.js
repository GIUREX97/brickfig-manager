import WebSocket from 'ws';
import fs from 'fs';
const ws = new WebSocket('ws://localhost:9222/devtools/page/64BD21C3B9BC09BE2B67DA7F8D2EE3E3');
ws.on('open', ()=>{
  ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{expression:"localStorage.getItem('brickfig_pro_v1')", returnByValue:true}}));
});
ws.on('message', async (data)=>{
  const msg=JSON.parse(data);
  if(msg.id===1){
    const val=msg.result.result.value;
    console.log('LEN:'+(val?val.length:0));
    if(val){
      fs.writeFileSync('C:/Users/gsimo/OneDrive/Documenti/Default Project/data/inventory.json', val);
      console.log('SCRITTO');
      try{
        const r=await fetch('http://localhost:3000/api/sync', {method:'POST', headers:{'Content-Type':'application/json'}, body: val});
        const j=await r.json();
        console.log('POST',JSON.stringify(j));
      }catch(e){ console.log('POST err',e.message); }
    } else {
      console.log('NESSUN DATO');
    }
    ws.close();
    setTimeout(()=>process.exit(0),1000);
  }
});
ws.on('error', e=>{ console.log('WS err',e.message); process.exit(1); });
setTimeout(()=>{ console.log('timeout'); process.exit(0); }, 8000);
