const fs = require('fs');
const path = require('path');

// Base path for quiz screenshots
const QUIZ_BASE_PATH = 'C:\\Users\\Neo\\.openclaw\\workspace\\quiz-scraping';

function createPreviewImages() {
  console.log('🖼️ Creating preview images...\n');
  
  const quizPreviews = {};
  const quizzes = ['bioma', 'terrashell', 'mounjaro', 'magnetmind', 'bliz-german'];
  
  for (const quiz of quizzes) {
    console.log(`Processing ${quiz}...`);
    const screenshotsPath = path.join(QUIZ_BASE_PATH, quiz, 'screenshots');
    
    if (!fs.existsSync(screenshotsPath)) {
      console.log(`❌ Not found: ${screenshotsPath}`);
      continue;
    }
    
    // Get first desktop screenshot
    const desktopScreenshots = fs.readdirSync(screenshotsPath)
      .filter(f => f.includes('desktop') && f.endsWith('.png'))
      .sort();
    
    if (desktopScreenshots.length > 0) {
      const firstDesktop = desktopScreenshots[0];
      const imagePath = path.join(screenshotsPath, firstDesktop);
      
      // Read file and convert to base64
      try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        
        // Store as data URI (limit size for preview)
        if (base64.length < 500000) { // ~500KB limit
          quizPreviews[quiz] = `data:image/png;base64,${base64}`;
          console.log(`✅ Created preview for ${quiz} (${Math.round(base64.length / 1024)}KB)`);
        } else {
          console.log(`⚠️ Image too large for ${quiz} (${Math.round(base64.length / 1024)}KB)`);
        }
      } catch (err) {
        console.error(`❌ Error reading ${firstDesktop}:`, err.message);
      }
    }
  }
  
  // Save previews
  fs.writeFileSync(
    path.join(__dirname, '..', 'public', 'quiz-previews.json'),
    JSON.stringify(quizPreviews, null, 2)
  );
  
  console.log('\n✅ Preview images created!');
  return quizPreviews;
}

createPreviewImages();