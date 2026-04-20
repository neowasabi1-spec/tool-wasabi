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

async function testAPI() {
  console.log('🔍 Testing Quiz Archive API...\n');
  
  const { default: fetch } = await import('node-fetch');
  
  // Test 1: Direct Supabase API
  console.log('1. Testing direct Supabase API:');
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/quiz_archive?select=*`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    
    const data = await response.json();
    console.log(`✅ Found ${data.length} entries`);
    data.forEach(q => console.log(`   - ${q.name}`));
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
  
  // Test 2: Next.js API route locally
  console.log('\n2. Testing local Next.js API:');
  try {
    const response = await fetch('http://localhost:3000/api/quiz-archive');
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Local API returned ${data.length} entries`);
    } else {
      console.log('❌ Local API error:', response.status);
    }
  } catch (error) {
    console.log('⚠️  Local server not running');
  }
  
  // Test 3: Production API
  console.log('\n3. Testing production API:');
  try {
    const response = await fetch('https://tool-wasabi-neo.netlify.app/api/quiz-archive');
    const text = await response.text();
    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    console.log('Response body:', text.substring(0, 200) + (text.length > 200 ? '...' : ''));
    
    try {
      const data = JSON.parse(text);
      console.log(`✅ Production API returned ${Array.isArray(data) ? data.length : 'unknown'} entries`);
    } catch (e) {
      console.log('❌ Could not parse response as JSON');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testAPI();