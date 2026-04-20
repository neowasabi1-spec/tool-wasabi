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

async function removeDuplicates() {
  console.log('🧹 Removing duplicate quiz entries...\n');
  
  const { default: fetch } = await import('node-fetch');
  
  try {
    // Get all quiz entries
    const response = await fetch(`${SUPABASE_URL}/rest/v1/quiz_archive?select=*&order=created_at.asc`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    
    const data = await response.json();
    console.log(`Found ${data.length} total entries`);
    
    // Group by name to find duplicates
    const byName = {};
    data.forEach(quiz => {
      if (!byName[quiz.name]) {
        byName[quiz.name] = [];
      }
      byName[quiz.name].push(quiz);
    });
    
    // Remove duplicates (keep the first one)
    for (const [name, quizzes] of Object.entries(byName)) {
      if (quizzes.length > 1) {
        console.log(`\n${name} has ${quizzes.length} entries`);
        console.log(`Keeping: ${quizzes[0].id} (created: ${quizzes[0].created_at})`);
        
        // Delete the duplicates
        for (let i = 1; i < quizzes.length; i++) {
          console.log(`Deleting: ${quizzes[i].id}`);
          
          const deleteResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/quiz_archive?id=eq.${quizzes[i].id}`,
            {
              method: 'DELETE',
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
              }
            }
          );
          
          if (!deleteResponse.ok) {
            console.error(`Failed to delete ${quizzes[i].id}`);
          }
        }
      }
    }
    
    console.log('\n✅ Duplicates removed!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

removeDuplicates();