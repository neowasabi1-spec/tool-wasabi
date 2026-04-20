// Fix per mostrare i dati in modo leggibile
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

// Contenuto leggibile da mettere nel campo funnel (che è quello che viene mostrato)
const readableFunnelContent = {
  "🔍 Overview": {
    "Project": "SeedPure Microplastic Detox",
    "Status": "✅ Fully Analyzed & Bypassed",
    "Total Pages": "11 pages mapped"
  },
  
  "📱 Frontend Flow": {
    "Domain": "getseedpure.com",
    "Step 1": "Advertorial → https://getseedpure.com/",
    "Step 2": "Quiz (8 steps) → https://getseedpure.com/quiz",
    "Step 3": "VSL/Landing → https://getseedpure.com/landing.html"
  },
  
  "💳 Backend Flow": {
    "Domain": "buyseedpure.com",
    "Checkout": "https://buyseedpure.com/checkout ($294)",
    "Upsell 1": "https://buyseedpure.com/upsell",
    "Upsell 2": "https://buyseedpure.com/upsell1",
    "OTO 1": "https://buyseedpure.com/oto",
    "OTO 2": "https://buyseedpure.com/oto1",
    "Special": "https://buyseedpure.com/special-offer",
    "Downsell": "https://buyseedpure.com/downsell",
    "Thank You": "https://buyseedpure.com/thank-you"
  },
  
  "🔧 Tech Stack": {
    "Frontend": "React SPA",
    "Checkout": "CheckoutChamp",
    "Tracking": "RedTrack",
    "Database": "SheetDB",
    "CDN": "Cloudflare"
  },
  
  "🔓 Security Issues": {
    "Issue 1": "❌ No order_id validation",
    "Issue 2": "❌ Session manipulation possible",
    "Issue 3": "❌ Product IDs exposed in code",
    "Issue 4": "❌ Direct upsell access without purchase"
  },
  
  "📦 Product IDs": {
    "HER": "343-377",
    "HIM": "349-369",
    "BUNDLE": "355-373"
  }
};

const updateData = {
  // Mettiamo il contenuto leggibile nel campo funnel che è quello mostrato
  funnel: readableFunnelContent,
  
  // E anche una versione string semplice nel campo brief
  brief: `
SEEDPURE FUNNEL - COMPLETE ANALYSIS

FRONTEND (getseedpure.com):
• Advertorial: https://getseedpure.com/
• Quiz: https://getseedpure.com/quiz
• VSL: https://getseedpure.com/landing.html

BACKEND (buyseedpure.com):
• Checkout: https://buyseedpure.com/checkout
• Upsells: /upsell, /upsell1, /oto, /oto1, /special-offer
• Downsell: https://buyseedpure.com/downsell
• Thank You: https://buyseedpure.com/thank-you

TECH: React SPA + CheckoutChamp + RedTrack
VULNERABILITIES: No validation, session manipulation, exposed IDs
STATUS: ✅ Bypass successful - All pages accessed
  `.trim(),
  
  updated_at: new Date().toISOString()
};

async function updateSupabase() {
  try {
    console.log('🚀 Fixing display format per Tool Wasabi...\n');
    
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
      console.log('✅ FORMATO SISTEMATO!\n');
      console.log('📊 Ora vedrai:');
      console.log('- Struttura organizzata con emoji');
      console.log('- URL completi e leggibili');
      console.log('- Sezioni ben separate');
      console.log('- Niente più JSON compresso!\n');
      console.log('🔄 Ricarica Tool Wasabi per vedere il nuovo formato');
      
    } else {
      const error = await response.text();
      console.error('❌ Errore:', error);
    }
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

updateSupabase();