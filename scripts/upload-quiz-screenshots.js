const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Base path for quiz screenshots
const QUIZ_BASE_PATH = 'C:\\Users\\Neo\\.openclaw\\workspace\\quiz-scraping';

async function uploadQuizScreenshots() {
  console.log('📸 Uploading quiz screenshots to Supabase Storage...\n');

  const quizFolders = ['bioma', 'terrashell', 'mounjaro', 'magnetmind', 'bliz-german'];
  
  for (const quizName of quizFolders) {
    console.log(`\n📁 Processing ${quizName}...`);
    
    const quizPath = path.join(QUIZ_BASE_PATH, quizName);
    const screenshotsPath = path.join(quizPath, 'screenshots');
    
    if (!fs.existsSync(screenshotsPath)) {
      console.log(`❌ Screenshots folder not found: ${screenshotsPath}`);
      continue;
    }
    
    // Get all screenshot files
    const files = fs.readdirSync(screenshotsPath).filter(f => f.endsWith('.png'));
    console.log(`Found ${files.length} screenshots`);
    
    // Upload first 5 screenshots as sample
    const samplesToUpload = files.slice(0, 5);
    
    for (const fileName of samplesToUpload) {
      const filePath = path.join(screenshotsPath, fileName);
      const fileBuffer = fs.readFileSync(filePath);
      
      // Upload to Supabase Storage
      const storagePath = `quiz-screenshots/${quizName}/${fileName}`;
      
      try {
        const { data, error } = await supabase.storage
          .from('funnel-assets')
          .upload(storagePath, fileBuffer, {
            contentType: 'image/png',
            cacheControl: '3600',
            upsert: true
          });
          
        if (error) {
          console.log(`❌ Failed to upload ${fileName}:`, error.message);
        } else {
          console.log(`✅ Uploaded ${fileName}`);
          
          // Get public URL
          const { data: urlData } = supabase.storage
            .from('funnel-assets')
            .getPublicUrl(storagePath);
            
          console.log(`   URL: ${urlData.publicUrl}`);
        }
      } catch (err) {
        console.error(`Error uploading ${fileName}:`, err.message);
      }
    }
  }
  
  console.log('\n✅ Upload complete!');
  console.log('\nNote: Only uploaded first 5 screenshots per quiz as samples.');
  console.log('To upload all screenshots, remove the .slice(0, 5) limit.');
}

// Alternative: Create a simple map of local paths
async function createScreenshotMap() {
  console.log('\n📝 Creating screenshot map...\n');
  
  const screenshotMap = {};
  const quizFolders = ['bioma', 'terrashell', 'mounjaro', 'magnetmind', 'bliz-german'];
  
  for (const quizName of quizFolders) {
    const quizPath = path.join(QUIZ_BASE_PATH, quizName);
    const screenshotsPath = path.join(quizPath, 'screenshots');
    
    if (!fs.existsSync(screenshotsPath)) {
      continue;
    }
    
    const files = fs.readdirSync(screenshotsPath).filter(f => f.endsWith('.png'));
    
    screenshotMap[quizName] = {
      path: screenshotsPath,
      screenshots: files.map((f, i) => ({
        filename: f,
        step: i + 1,
        device: f.includes('mobile') ? 'mobile' : 'desktop',
        fullPath: path.join(screenshotsPath, f)
      }))
    };
  }
  
  // Save the map
  fs.writeFileSync(
    path.join(__dirname, '..', 'quiz-screenshot-map.json'),
    JSON.stringify(screenshotMap, null, 2)
  );
  
  console.log('✅ Screenshot map created: quiz-screenshot-map.json');
}

// Run both functions
async function main() {
  // First create the map
  await createScreenshotMap();
  
  // Then try to upload (if you have Supabase storage configured)
  // Uncomment the next line to upload
  // await uploadQuizScreenshots();
}

main();