// Logica calcolo preventivo spedizioni USA <-> ITA
// Volumetrico: L*W*H / 5000 (cm/kg) - standard aereo
export function volumetricWeight(l,w,h){
  if(!l||!w||!h) return 0;
  return (Number(l)*Number(w)*Number(h))/5000;
}
export function billableWeight(pesoReale, l,w,h){
  const vol = volumetricWeight(l,w,h);
  return Math.max(Number(pesoReale)||0, vol);
}
export const TARIFFE = {
  baseFee: 22, // € fissi gestione
  handlingDoganale: 18, // €
  assicurazionePct: 0.02, // 2%
  assicurazioneMin: 8,
  perKgScaglioni: [
    { fino: 0.5, euroPerKg: 28, minTot: 32 },
    { fino: 2, euroPerKg: 22, minTot: 0 },
    { fino: 5, euroPerKg: 15, minTot: 0 },
    { fino: 10, euroPerKg: 12.5, minTot: 0 },
    { fino: 20, euroPerKg: 10.2, minTot: 0 },
    { fino: 30, euroPerKg: 9.1, minTot: 0 },
    { fino: 70, euroPerKg: 8.0, minTot: 0 },
    { fino: 9999, euroPerKg: 7.2, minTot: 0 },
  ],
  supplementoDirezione: {
    'USA->ITA': 0, // base
    'ITA->USA': 0.06 // +6% export
  },
  servizioMoltiplicatore: {
    economy: 0.92,
    priority: 1.00,
    express: 1.42
  },
  tempi: {
    economy: { min: 8, max: 12, label: '8-12 giorni lavorativi' },
    priority: { min: 5, max: 7, label: '5-7 giorni lavorativi' },
    express: { min: 2, max: 4, label: '2-4 giorni lavorativi' }
  }
};

export function prezzoPerKgRange(pesoFatturabile){
  for(const s of TARIFFE.perKgScaglioni){
    if(pesoFatturabile <= s.fino) return s;
  }
  return TARIFFE.perKgScaglioni[TARIFFE.perKgScaglioni.length-1];
}

export function calcolaPreventivo({direzione='USA->ITA', peso, lunghezza, larghezza, altezza, valore=0, servizio='priority', assicurazione=false, doganaInclusa=true}){
  const pesoReal = Math.max(0.1, Number(peso)||0.1);
  const vol = volumetricWeight(lunghezza,larghezza,altezza);
  const pesoFatt = billableWeight(pesoReal, lunghezza,larghezza,altezza);
  // arrotonda a 0.5 kg per scaglioni? usiamo reale con step 0.1
  const scaglione = prezzoPerKgRange(pesoFatt);
  let costoKg = pesoFatt * scaglione.euroPerKg;
  if(scaglione.minTot && costoKg < scaglione.minTot) costoKg = scaglione.minTot;
  let base = costoKg + TARIFFE.baseFee;
  // supplemento direzione
  const supp = TARIFFE.supplementoDirezione[direzione] || 0;
  base = base * (1 + supp);
  // servizio
  const mult = TARIFFE.servizioMoltiplicatore[servizio] || 1;
  let subtotale = base * mult;
  let extraAss = 0;
  if(assicurazione){
    extraAss = Math.max(TARIFFE.assicurazioneMin, (Number(valore)||0)*TARIFFE.assicurazionePct);
  }
  let extraDogana = doganaInclusa ? TARIFFE.handlingDoganale : 0;
  let totale = subtotale + extraAss + extraDogana;
  // arrotonda a 0.50
  totale = Math.round(totale*2)/2;
  subtotale = Math.round(subtotale*100)/100;
  // stima dazi doganali indicativi (non inclusi)
  const stimaDazi = (Number(valore)||0) > 150 ? Math.round((Number(valore)*0.04 + Number(valore)*0.22*0.2)*100)/100 : 0; // semplificata
  return {
    pesoReale: Math.round(pesoReal*100)/100,
    volumetrico: Math.round(vol*100)/100,
    pesoFatturabile: Math.round(pesoFatt*100)/100,
    scaglione,
    costoKg: Math.round(costoKg*100)/100,
    baseFee: TARIFFE.baseFee,
    supplementoDirezione: supp,
    servizio,
    moltiplicatore: mult,
    subtotale,
    extraAssicurazione: Math.round(extraAss*100)/100,
    extraDogana,
    totale,
    tempi: TARIFFE.tempi[servizio],
    stimaDazi,
    valuta: 'EUR',
    direzione
  };
}

export function generaCodicePreventivo(){
  const d = new Date();
  const y = String(d.getFullYear()).slice(2);
  const rand = Math.random().toString(36).slice(2,6).toUpperCase();
  return `PREV-${y}${String(d.getMonth()+1).padStart(2,'0')}${rand}`;
}
export function generaCodiceSpedizione(){
  const d = new Date();
  const rand = Math.random().toString(36).slice(2,7).toUpperCase();
  return `SHIP-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${rand}`;
}
