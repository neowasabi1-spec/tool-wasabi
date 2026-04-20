// Script per salvare i dati in formato leggibile
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

// Formato leggibile per il campo description/notes
const readableDescription = `
🗺️ SEEDPURE FUNNEL STRUCTURE

📱 FRONTEND (getseedpure.com)
├─ Advertorial: https://getseedpure.com/
├─ Quiz (8 steps): https://getseedpure.com/quiz  
└─ VSL/Landing: https://getseedpure.com/landing.html

💳 BACKEND (buyseedpure.com)
├─ Checkout ($294): https://buyseedpure.com/checkout
├─ Upsell 1: https://buyseedpure.com/upsell
├─ Upsell 2: https://buyseedpure.com/upsell1
├─ OTO 1: https://buyseedpure.com/oto
├─ OTO 2: https://buyseedpure.com/oto1
├─ Special Offer: https://buyseedpure.com/special-offer
├─ Downsell: https://buyseedpure.com/downsell
└─ Thank You: https://buyseedpure.com/thank-you

🔧 TECH STACK
• Frontend: React SPA
• Checkout: CheckoutChamp
• Tracking: RedTrack
• Database: SheetDB
• Hidden Backend: orders.luxuryconfidence.com

🔓 VULNERABILITIES FOUND
• No order_id validation (any value works)
• Session manipulation via JavaScript
• Product IDs exposed in client code
• Direct access to upsells without purchase

📦 PRODUCT IDS
• HER: 343-377 (one-time & subscription)
• HIM: 349-369 (one-time & subscription)
• BUNDLE: 355-373 (one-time & subscription)

✅ STATUS: Bypass successful - All pages accessed
`;

const updateData = {
  name: "SeedPure - Microplastic Detox Funnel",
  description: readableDescription.trim(),
  status: "analyzed",
  tags: ["supplement", "fertility", "microplastics", "bypassed", "checkoutchamp"],
  domain: "getseedpure.com",
  
  // Manteniamo la struttura JSON nel campo funnel per processamento
  funnel: {
    pages_count: 11,
    frontend_domain: "getseedpure.com",
    backend_domain: "buyseedpure.com",
    tech_stack: ["React SPA", "CheckoutChamp", "RedTrack", "SheetDB"],
    vulnerabilities_count: 4,
    bypass_status: "successful"
  },
  
  // Struttura semplificata per i campi front/back
  front_end: {
    advertorial: "https://getseedpure.com/",
    quiz: "https://getseedpure.com/quiz",
    vsl: "https://getseedpure.com/landing.html"
  },
  
  back_end: {
    checkout: "https://buyseedpure.com/checkout",
    upsells: [
      "https://buyseedpure.com/upsell",
      "https://buyseedpure.com/upsell1",
      "https://buyseedpure.com/oto",
      "https://buyseedpure.com/oto1",
      "https://buyseedpure.com/special-offer"
    ],
    downsell: "https://buyseedpure.com/downsell",
    thankyou: "https://buyseedpure.com/thank-you"
  },
  
  notes: "BYPASS SUCCESS ✅ Critical security flaws found. Full funnel structure mapped without purchase.",
  
  updated_at: new Date().toISOString()
};

// Aggiorna Supabase
async function updateSupabase() {
  try {
    console.log('🚀 Aggiornamento SeedPure con formato leggibile...\n');
    
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
      console.log('📊 Ora nel Tool Wasabi vedrai:');
      console.log('- Descrizione formattata e leggibile');
      console.log('- Struttura ad albero del funnel');
      console.log('- URL organizzati per sezione');
      console.log('- Vulnerabilità elencate chiaramente');
      console.log('- Tech stack ben visibile');
      console.log('\n🎯 Niente più JSON illeggibile!');
      
    } else {
      const error = await response.text();
      console.error('❌ Errore:', error);
    }
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

updateSupabase();