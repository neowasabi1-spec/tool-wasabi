// Fix finale con formattazione corretta per Tool Wasabi
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

// Descrizione formattata con interruzioni di riga corrette
const formattedDescription = `🗺️ SEEDPURE FUNNEL STRUCTURE

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

✅ STATUS: Bypass successful - All pages accessed`;

const updateData = {
  // Mettiamo la descrizione formattata nel campo description
  description: formattedDescription,
  
  // E un oggetto semplice nel campo funnel
  funnel: {
    frontend: ["advertorial", "quiz", "vsl"],
    backend: ["checkout", "upsell1", "upsell2", "oto1", "oto2", "special-offer", "downsell", "thankyou"],
    total_pages: 11,
    tech: "React SPA + CheckoutChamp",
    status: "bypassed"
  },
  
  // Tags aggiornati
  tags: ["supplement", "fertility", "microplastics", "analyzed", "bypassed", "checkoutchamp"],
  
  updated_at: new Date().toISOString()
};

async function updateSupabase() {
  try {
    console.log('🚀 Final fix con formattazione corretta...\n');
    
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
      console.log('✅ FORMATTAZIONE SISTEMATA!\n');
      console.log('📊 Ora nel campo Description vedrai:');
      console.log('- Testo formattato con interruzioni di riga');
      console.log('- Struttura ad albero ben visibile');
      console.log('- Emoji e indentazione corretta');
      console.log('- URL completi e organizzati\n');
      console.log('🎯 Tutto leggibile e ben strutturato!');
      console.log('🔄 Ricarica Tool Wasabi per vedere il risultato finale');
      
    } else {
      const error = await response.text();
      console.error('❌ Errore:', error);
    }
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

updateSupabase();