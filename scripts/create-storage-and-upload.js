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
const SUPABASE_SERVICE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY not found in .env.local');
  console.log('Please add it to upload files');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const QUIZ_BASE_PATH = 'C:\\Users\\Neo\\.openclaw\\workspace\\quiz-scraping';

async function setupStorageAndUpload() {
  console.log('🪣 Creating storage bucket...\n');

  // Create bucket
  const { data: bucketData, error: bucketError } = await supabase.storage.createBucket('quiz-screenshots', {
    public: true,
    fileSizeLimit: 10485760, // 10MB
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp']
  });

  if (bucketError && !bucketError.message.includes('already exists')) {
    console.error('❌ Error creating bucket:', bucketError);
    return;
  }

  console.log('✅ Bucket ready!\n');

  // Upload screenshots
  const quizzes = ['bioma', 'terrashell', 'mounjaro', 'magnetmind', 'bliz-german'];
  const uploadedData = {};

  for (const quiz of quizzes) {
    console.log(`📸 Uploading ${quiz} screenshots...`);
    uploadedData[quiz] = { screenshots: [], htmlCount: 0 };
    
    const screenshotsPath = path.join(QUIZ_BASE_PATH, quiz, 'screenshots');
    const htmlPath = path.join(QUIZ_BASE_PATH, quiz, 'html');
    
    // Count HTML files
    if (fs.existsSync(htmlPath)) {
      const htmlFiles = fs.readdirSync(htmlPath).filter(f => f.endsWith('.html'));
      uploadedData[quiz].htmlCount = htmlFiles.length;
    }
    
    if (!fs.existsSync(screenshotsPath)) {
      console.log(`❌ Screenshots not found for ${quiz}`);
      continue;
    }

    const screenshots = fs.readdirSync(screenshotsPath)
      .filter(f => f.endsWith('.png'))
      .sort();

    // Upload each screenshot
    for (const filename of screenshots) {
      const filePath = path.join(screenshotsPath, filename);
      const fileBuffer = fs.readFileSync(filePath);
      const uploadPath = `${quiz}/${filename}`;

      try {
        const { data, error } = await supabase.storage
          .from('quiz-screenshots')
          .upload(uploadPath, fileBuffer, {
            contentType: 'image/png',
            upsert: true
          });

        if (error) {
          console.log(`❌ Failed ${filename}:`, error.message);
        } else {
          const { data: { publicUrl } } = supabase.storage
            .from('quiz-screenshots')
            .getPublicUrl(uploadPath);
          
          uploadedData[quiz].screenshots.push({
            filename,
            url: publicUrl,
            step: parseInt(filename.match(/step-(\d+)/)?.[1] || '0'),
            device: filename.includes('mobile') ? 'mobile' : 'desktop'
          });
          
          console.log(`✅ ${filename}`);
        }
      } catch (err) {
        console.error(`Error uploading ${filename}:`, err.message);
      }
    }
  }

  // Update database with URLs
  console.log('\n📝 Updating database...\n');
  
  for (const [quizName, data] of Object.entries(uploadedData)) {
    if (data.screenshots.length > 0) {
      const capitalizedName = quizName.charAt(0).toUpperCase() + quizName.slice(1);
      
      // Group by step
      const stepGroups = {};
      data.screenshots.forEach(s => {
        if (!stepGroups[s.step]) {
          stepGroups[s.step] = {};
        }
        stepGroups[s.step][s.device] = s.url;
      });
      
      const updateData = {
        screenshot_urls: data.screenshots.map(s => s.url),
        screenshot_data: stepGroups,
        html_files_count: data.htmlCount
      };
      
      const { error } = await supabase
        .from('quiz_archive')
        .update(updateData)
        .eq('name', capitalizedName);
        
      if (error) {
        console.log(`❌ Failed to update ${capitalizedName}:`, error.message);
      } else {
        console.log(`✅ Updated ${capitalizedName} with ${data.screenshots.length} screenshots and ${data.htmlCount} HTML files`);
      }
    }
  }

  // Save upload summary
  fs.writeFileSync(
    path.join(__dirname, '..', 'quiz-uploads-summary.json'),
    JSON.stringify(uploadedData, null, 2)
  );

  console.log('\n🎉 All done! Screenshots are now online.');
}

setupStorageAndUpload();