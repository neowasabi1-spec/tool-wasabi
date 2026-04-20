// Script autonomo per aggiornare SeedPure in Supabase
const fs = require('fs');
const path = require('path');

// Leggi le credenziali dall'env
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Credenziali Supabase mancanti');
  process.exit(1);
}

const projectId = '0d510a60-ff41-4e1c-8bb8-398da3096892';

const updateData = {
  funnel_structure: {
    frontend: {
      domain: "getseedpure.com",
      flow: "advertorial → quiz → vsl/landing",
      pages: {
        advertorial: {
          url: "https://getseedpure.com/",
          type: "Advertorial",
          description: "Amanda Rivera emotional story",
          elements: ["Multiple CTAs", "Emotional hook", "Problem agitation"]
        },
        quiz: {
          url: "https://getseedpure.com/quiz",
          type: "Quiz",
          steps: 8,
          features: ["Profile segmentation", "Email capture via SheetDB", "23-min timer"]
        },
        vsl: {
          url: "https://getseedpure.com/landing.html",
          type: "VSL/Landing",
          features: ["55% off limited offer", "Media credibility", "Dynamic content"]
        }
      }
    },
    backend: {
      domain: "buyseedpure.com",
      flow: "checkout → upsells → downsell → thankyou",
      pages: {
        checkout: {
          url: "https://buyseedpure.com/checkout",
          type: "Checkout",
          processor: "CheckoutChamp",
          price: "$294 (6-month bundle)"
        },
        upsells: [
          { url: "https://buyseedpure.com/upsell", type: "Upsell 1" },
          { url: "https://buyseedpure.com/upsell1", type: "Upsell 2" },
          { url: "https://buyseedpure.com/oto", type: "OTO 1" },
          { url: "https://buyseedpure.com/oto1", type: "OTO 2" },
          { url: "https://buyseedpure.com/special-offer", type: "Special Offer" }
        ],
        downsell: {
          url: "https://buyseedpure.com/downsell",
          type: "Downsell"
        },
        thankyou: {
          url: "https://buyseedpure.com/thank-you",
          type: "Thank You Page"
        }
      }
    },
    techStack: {
      frontend: "React SPA",
      checkout: "CheckoutChamp",
      tracking: "RedTrack",
      database: "SheetDB",
      cdn: "Cloudflare",
      hiddenBackend: "orders.luxuryconfidence.com"
    },
    productIds: {
      her: { oneTime: [343, 345, 347], subscription: [361, 363, 377] },
      him: { oneTime: [349, 351, 353], subscription: [365, 367, 369] },
      bundle: { oneTime: [355, 357, 359], subscription: [371, 373] }
    },
    vulnerabilities: {
      orderValidation: "No server-side validation - any order_id works",
      sessionSecurity: "Session can be manipulated via JavaScript",
      exposedData: "Product IDs and funnel structure visible in client code"
    }
  },
  tech_stack: "React SPA + CheckoutChamp + RedTrack + SheetDB + Cloudflare",
  updated_at: new Date().toISOString()
};

// Usa node-fetch per la chiamata HTTP
async function updateSupabase() {
  try {
    console.log('🚀 Aggiornamento automatico SeedPure in corso...\n');
    
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
      const result = await response.json();
      console.log('✅ AGGIORNAMENTO COMPLETATO CON SUCCESSO!\n');
      console.log('📊 Dati aggiornati:');
      console.log('- Struttura funnel completa');
      console.log('- Tutti gli URL (11 pagine totali)');
      console.log('- Tech stack identificato');
      console.log('- Vulnerabilità documentate');
      console.log('- Status: Complete - Bypassed\n');
      console.log('🎯 Il Tool Wasabi ora mostra tutti i dati del funnel SeedPure!');
      
      // Salva anche un backup locale
      fs.writeFileSync(
        path.join(__dirname, '..', 'data', 'projects', 'seedpure', 'supabase-backup.json'),
        JSON.stringify(result, null, 2)
      );
      console.log('\n💾 Backup salvato in: data/projects/seedpure/supabase-backup.json');
      
    } else {
      const error = await response.text();
      console.error('❌ Errore aggiornamento:', response.status, error);
    }
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

updateSupabase();