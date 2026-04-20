// Soluzione con formattazione HTML per Tool Wasabi
const fs = require('fs');
const path = require('path');

// Leggi le credenziali
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    envVars[key.trim()] = value.trim();
  }
});

const SUPABASE_URL = envVars.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const projectId = '0d510a60-ff41-4e1c-8bb8-398da3096892';

// Proviamo con HTML breaks
const htmlDescription = `🗺️ SEEDPURE FUNNEL STRUCTURE<br/><br/>📱 FRONTEND (getseedpure.com)<br/>├─ Advertorial: https://getseedpure.com/<br/>├─ Quiz (8 steps): https://getseedpure.com/quiz<br/>└─ VSL/Landing: https://getseedpure.com/landing.html<br/><br/>💳 BACKEND (buyseedpure.com)<br/>├─ Checkout ($294): https://buyseedpure.com/checkout<br/>├─ Upsell 1: https://buyseedpure.com/upsell<br/>├─ Upsell 2: https://buyseedpure.com/upsell1<br/>├─ OTO 1: https://buyseedpure.com/oto<br/>├─ OTO 2: https://buyseedpure.com/oto1<br/>├─ Special Offer: https://buyseedpure.com/special-offer<br/>├─ Downsell: https://buyseedpure.com/downsell<br/>└─ Thank You: https://buyseedpure.com/thank-you<br/><br/>🔧 TECH STACK<br/>• Frontend: React SPA<br/>• Checkout: CheckoutChamp<br/>• Tracking: RedTrack<br/>• Database: SheetDB<br/>• Hidden Backend: orders.luxuryconfidence.com<br/><br/>🔓 VULNERABILITIES FOUND<br/>• No order_id validation<br/>• Session manipulation via JavaScript<br/>• Product IDs exposed<br/>• Direct upsell access without purchase<br/><br/>📦 PRODUCT IDS<br/>• HER: 343-377<br/>• HIM: 349-369<br/>• BUNDLE: 355-373<br/><br/>✅ STATUS: Bypass successful`;

// Alternativa: salviamo in notes che forse renderizza meglio
const simpleNotes = `FUNNEL STRUCTURE:

Frontend (getseedpure.com):
- Advertorial: https://getseedpure.com/
- Quiz: https://getseedpure.com/quiz  
- VSL: https://getseedpure.com/landing.html

Backend (buyseedpure.com):
- Checkout: https://buyseedpure.com/checkout ($294)
- Upsells: /upsell, /upsell1, /oto, /oto1, /special-offer
- Downsell: https://buyseedpure.com/downsell
- Thank You: https://buyseedpure.com/thank-you

Tech: React SPA + CheckoutChamp + RedTrack
Vulnerabilities: No validation, session manipulation, exposed IDs
Status: Bypass successful - All pages accessed`;

const updateData = {
  // Prova 1: HTML nel description
  description: htmlDescription,
  
  // Prova 2: testo semplice nel campo notes
  notes: simpleNotes,
  
  // Manteniamo il resto
  tags: ["seedpure", "analyzed", "bypassed"],
  
  updated_at: new Date().toISOString()
};

async function updateSupabase() {
  try {
    console.log('🚀 Tentativo con formato HTML e notes semplici...\n');
    
    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${projectId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(updateData)
    });

    if (response.ok) {
      console.log('✅ AGGIORNAMENTO COMPLETATO!\n');
      console.log('Ho provato 2 approcci:');
      console.log('1. HTML breaks nel campo description');
      console.log('2. Testo semplice nel campo notes\n');
      console.log('🔄 Ricarica e controlla quale campo mostra meglio i dati');
      console.log('\nSe ancora non funziona, probabilmente il Tool Wasabi');
      console.log('necessita di modifiche al codice per supportare la formattazione.');
      
    } else {
      const error = await response.text();
      console.error('❌ Errore:', error);
    }
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

updateSupabase();