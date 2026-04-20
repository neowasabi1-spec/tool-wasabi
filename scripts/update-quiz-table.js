const fs = require('fs');
const path = require('path');

// Leggi credenziali
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

// Load the upload summary
const summaryPath = path.join(__dirname, '..', 'quiz-uploads-summary.json');
const uploadSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

async function updateQuizUrls() {
  console.log('📝 Updating quiz URLs in database...\n');
  
  const { default: fetch } = await import('node-fetch');
  
  for (const [quizName, data] of Object.entries(uploadSummary)) {
    if (data.screenshots && data.screenshots.length > 0) {
      const capitalizedName = quizName.charAt(0).toUpperCase() + quizName.slice(1);
      
      // Just update with the URLs array for now
      const urls = data.screenshots.map(s => s.url);
      
      const updateResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/quiz_archive?name=eq.${capitalizedName}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            screenshot_urls: urls
          })
        }
      );
      
      if (updateResponse.ok) {
        console.log(`✅ Updated ${capitalizedName} with ${urls.length} screenshot URLs`);
        console.log(`   First URL: ${urls[0]}`);
      } else {
        console.log(`❌ Failed to update ${capitalizedName}:`, await updateResponse.text());
      }
    }
  }
  
  console.log('\n✅ Done!');
}

updateQuizUrls();