// Script corretto per aggiornare SeedPure in Supabase
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

const projectId = '0d510a60-ff41-4e1c-8bb8-398da3096892';

const funnelStructure = {
  frontend: {
    domain: "getseedpure.com",
    flow: "advertorial → quiz → vsl/landing",
    pages: {
      advertorial: {
        url: "https://getseedpure.com/",
        type: "Advertorial",
        description: "Amanda Rivera emotional story"
      },
      quiz: {
        url: "https://getseedpure.com/quiz",
        type: "Quiz",
        steps: 8
      },
      vsl: {
        url: "https://getseedpure.com/landing.html",
        type: "VSL/Landing"
      }
    }
  },
  backend: {
    domain: "buyseedpure.com",
    flow: "checkout → upsells → downsell → thankyou",
    pages: {
      checkout: {
        url: "https://buyseedpure.com/checkout",
        processor: "CheckoutChamp",
        price: "$294"
      },
      upsells: [
        "https://buyseedpure.com/upsell",
        "https://buyseedpure.com/upsell1",
        "https://buyseedpure.com/oto",
        "https://buyseedpure.com/oto1",
        "https://buyseedpure.com/special-offer"
      ],
      downsell: "https://buyseedpure.com/downsell",
      thankyou: "https://buyseedpure.com/thank-you"
    }
  },
  techStack: "React SPA + CheckoutChamp + RedTrack",
  vulnerabilities: [
    "No order_id validation",
    "Session manipulation via JS",
    "Product IDs exposed"
  ]
};

const updateData = {
  name: "SeedPure Microplastic Detox Funnel",
  description: "Competitor funnel analysis - Complete structure mapped and security bypassed",
  status: "analyzed",
  tags: ["supplement", "fertility", "microplastics", "bypassed"],
  notes: "BYPASS SUCCESS: Found critical vulnerabilities. Any order_id grants access to upsells. Product IDs: HER (343-377), HIM (349-369), BUNDLE (355-373). CheckoutChamp backend on orders.luxuryconfidence.com",
  domain: "getseedpure.com",
  
  // Salvo la struttura del funnel nel campo 'funnel' che esiste
  funnel: funnelStructure,
  
  // Front-end pages
  front_end: {
    pages: [
      {
        type: "advertorial",
        url: "https://getseedpure.com/",
        title: "Amanda's Fertility Story"
      },
      {
        type: "quiz",
        url: "https://getseedpure.com/quiz",
        title: "8-Step Fertility Quiz"
      },
      {
        type: "vsl",
        url: "https://getseedpure.com/landing.html",
        title: "SeedPure VSL"
      }
    ]
  },
  
  // Back-end pages
  back_end: {
    pages: [
      {
        type: "checkout",
        url: "https://buyseedpure.com/checkout",
        processor: "CheckoutChamp"
      },
      {
        type: "upsells",
        urls: [
          "https://buyseedpure.com/upsell",
          "https://buyseedpure.com/upsell1",
          "https://buyseedpure.com/oto",
          "https://buyseedpure.com/oto1",
          "https://buyseedpure.com/special-offer"
        ]
      },
      {
        type: "downsell",
        url: "https://buyseedpure.com/downsell"
      },
      {
        type: "thankyou",
        url: "https://buyseedpure.com/thank-you"
      }
    ]
  },
  
  updated_at: new Date().toISOString()
};

// Aggiorna Supabase
async function updateSupabase() {
  try {
    console.log('🚀 Aggiornamento automatico SeedPure in Supabase...\n');
    
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
      console.log('✅ AGGIORNAMENTO COMPLETATO AUTOMATICAMENTE!\n');
      console.log('📊 Salvati in Supabase:');
      console.log('- Nome: SeedPure Microplastic Detox Funnel');
      console.log('- Status: analyzed');
      console.log('- Struttura completa del funnel');
      console.log('- Vulnerabilità documentate nelle note');
      console.log('- 11 URL totali mappati');
      console.log('- Tech stack: React SPA + CheckoutChamp');
      console.log('\n🎯 Tool Wasabi aggiornato con successo!');
      console.log('🔄 Ricarica la pagina per vedere i cambiamenti');
      
      // Backup
      const backupPath = path.join(__dirname, '..', 'data', 'projects', 'seedpure', 'supabase-result.json');
      fs.writeFileSync(backupPath, JSON.stringify(result[0], null, 2));
      console.log(`\n💾 Backup: ${backupPath}`);
      
    } else {
      const error = await response.text();
      console.error('❌ Errore:', response.status, error);
    }
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

updateSupabase();