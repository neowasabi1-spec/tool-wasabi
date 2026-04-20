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
const SUPABASE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY || envVars.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Base path for quiz screenshots
const QUIZ_BASE_PATH = 'C:\\Users\\Neo\\.openclaw\\workspace\\quiz-scraping';

async function uploadAllScreenshots() {
  console.log('📸 Uploading ALL quiz screenshots to Supabase...\n');
  
  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;
  
  const quizFolders = ['bioma', 'terrashell', 'mounjaro', 'magnetmind', 'bliz-german'];
  const uploadedUrls = {};
  
  // First, create the bucket if it doesn't exist
  console.log('🪣 Checking Storage bucket...');
  const bucketResponse = await fetch(`${SUPABASE_URL}/storage/v1/bucket/quiz-screenshots`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'quiz-screenshots',
      public: true
    })
  });
  
  if (bucketResponse.ok) {
    console.log('✅ Bucket created/verified');
  } else {
    const error = await bucketResponse.text();
    if (!error.includes('already exists')) {
      console.log('⚠️ Bucket check response:', error);
    }
  }
  
  for (const quizName of quizFolders) {
    console.log(`\n📁 Uploading ${quizName}...`);
    uploadedUrls[quizName] = [];
    
    const screenshotsPath = path.join(QUIZ_BASE_PATH, quizName, 'screenshots');
    
    if (!fs.existsSync(screenshotsPath)) {
      console.log(`❌ Screenshots folder not found: ${screenshotsPath}`);
      continue;
    }
    
    const files = fs.readdirSync(screenshotsPath).filter(f => f.endsWith('.png'));
    console.log(`Found ${files.length} screenshots`);
    
    // Upload ALL screenshots
    for (const fileName of files) {
      const filePath = path.join(screenshotsPath, fileName);
      const fileBuffer = fs.readFileSync(filePath);
      const storagePath = `${quizName}/${fileName}`;
      
      try {
        // Upload using Storage API
        const uploadResponse = await fetch(
          `${SUPABASE_URL}/storage/v1/object/quiz-screenshots/${storagePath}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'image/png',
              'x-upsert': 'true'
            },
            body: fileBuffer
          }
        );
        
        if (uploadResponse.ok) {
          console.log(`✅ ${fileName}`);
          
          // Store public URL
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/quiz-screenshots/${storagePath}`;
          uploadedUrls[quizName].push({
            fileName,
            url: publicUrl,
            step: parseInt(fileName.match(/step-(\d+)/)?.[1] || '0'),
            device: fileName.includes('mobile') ? 'mobile' : 'desktop'
          });
        } else {
          const error = await uploadResponse.text();
          console.log(`❌ Failed ${fileName}:`, error);
        }
      } catch (err) {
        console.error(`Error uploading ${fileName}:`, err.message);
      }
    }
  }
  
  // Save URLs map
  fs.writeFileSync(
    path.join(__dirname, '..', 'quiz-screenshot-urls.json'),
    JSON.stringify(uploadedUrls, null, 2)
  );
  
  console.log('\n✅ Upload complete! URLs saved to quiz-screenshot-urls.json');
  
  // Update database with screenshot URLs
  console.log('\n📝 Updating database with URLs...');
  
  for (const [quizName, screenshots] of Object.entries(uploadedUrls)) {
    if (screenshots.length > 0) {
      // Get first desktop and mobile screenshots
      const firstDesktop = screenshots.find(s => s.device === 'desktop');
      const firstMobile = screenshots.find(s => s.device === 'mobile');
      
      // Update quiz record
      const updateData = {
        screenshot_urls: screenshots.map(s => s.url),
        preview_desktop: firstDesktop?.url,
        preview_mobile: firstMobile?.url
      };
      
      const updateResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/quiz_archive?name=eq.${quizName.charAt(0).toUpperCase() + quizName.slice(1)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(updateData)
        }
      );
      
      if (updateResponse.ok) {
        console.log(`✅ Updated ${quizName} with ${screenshots.length} screenshot URLs`);
      }
    }
  }
  
  console.log('\n🎉 All done! Screenshots are now online.');
}

uploadAllScreenshots();