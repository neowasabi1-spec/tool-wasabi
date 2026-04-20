const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

async function updateSeedPureStructure() {
  console.log('📊 Aggiornamento struttura SeedPure nel Tool Wasabi...\n');

  const projectId = '0d510a60-ff41-4e1c-8bb8-398da3096892';
  
  // Struttura pulita del funnel
  const cleanStructure = {
    frontend: {
      domain: 'getseedpure.com',
      pages: {
        advertorial: {
          url: 'https://getseedpure.com/',
          type: 'Advertorial',
          description: 'Amanda Rivera emotional story',
          elements: ['Multiple CTAs', 'Emotional hook', 'Problem agitation']
        },
        quiz: {
          url: 'https://getseedpure.com/quiz',
          type: 'Quiz',
          steps: 8,
          features: ['Profile segmentation', 'Email capture via SheetDB', '23-min timer']
        },
        vsl: {
          url: 'https://getseedpure.com/landing.html',
          type: 'VSL/Landing',
          features: ['55% off limited offer', 'Media credibility', 'Dynamic content']
        }
      }
    },
    backend: {
      domain: 'buyseedpure.com',
      pages: {
        checkout: {
          url: 'https://buyseedpure.com/checkout',
          type: 'Checkout',
          processor: 'CheckoutChamp',
          price: '$294 (6-month bundle)'
        },
        upsells: [
          { url: 'https://buyseedpure.com/upsell', type: 'Upsell 1' },
          { url: 'https://buyseedpure.com/upsell1', type: 'Upsell 2' },
          { url: 'https://buyseedpure.com/oto', type: 'OTO 1' },
          { url: 'https://buyseedpure.com/oto1', type: 'OTO 2' },
          { url: 'https://buyseedpure.com/special-offer', type: 'Special Offer' }
        ],
        downsell: {
          url: 'https://buyseedpure.com/downsell',
          type: 'Downsell'
        },
        thankyou: {
          url: 'https://buyseedpure.com/thank-you',
          type: 'Thank You Page'
        }
      }
    },
    techStack: {
      frontend: 'React SPA',
      checkout: 'CheckoutChamp',
      tracking: 'RedTrack',
      database: 'SheetDB',
      cdn: 'Cloudflare',
      hiddenBackend: 'orders.luxuryconfidence.com'
    },
    productIds: {
      her: { oneTime: [343, 345, 347], subscription: [361, 363, 377] },
      him: { oneTime: [349, 351, 353], subscription: [365, 367, 369] },
      bundle: { oneTime: [355, 357, 359], subscription: [371, 373] }
    },
    vulnerabilities: {
      orderValidation: 'No server-side validation - any order_id works',
      sessionSecurity: 'Session can be manipulated via JavaScript',
      exposedData: 'Product IDs and funnel structure visible in client code'
    }
  };

  try {
    // Aggiorna il progetto con la struttura pulita
    const { data, error } = await supabase
      .from('projects')
      .update({ 
        funnel_structure: cleanStructure,
        tech_stack: cleanStructure.techStack,
        vulnerabilities_found: cleanStructure.vulnerabilities,
        analysis_status: 'Complete - Bypassed',
        updated_at: new Date().toISOString()
      })
      .eq('id', projectId);

    if (error) {
      console.error('❌ Errore aggiornamento:', error);
      return;
    }

    console.log('✅ Struttura funnel aggiornata con successo!');
    
    // Mostra riepilogo
    console.log('\n📊 RIEPILOGO STRUTTURA:');
    console.log('- Frontend:', cleanStructure.frontend.domain);
    console.log('- Backend:', cleanStructure.backend.domain);
    console.log('- Tech Stack:', cleanStructure.techStack.frontend + ' + ' + cleanStructure.techStack.checkout);
    console.log('- Upsells trovati:', cleanStructure.backend.pages.upsells.length);
    console.log('- Vulnerabilità:', Object.keys(cleanStructure.vulnerabilities).length);
    
    // Salva anche in locale
    const fs = require('fs');
    const configPath = './data/projects/seedpure/funnel-structure.json';
    fs.writeFileSync(configPath, JSON.stringify(cleanStructure, null, 2));
    console.log('\n💾 Salvato anche in:', configPath);
    
  } catch (error) {
    console.error('❌ Errore:', error);
  }
}

updateSeedPureStructure();