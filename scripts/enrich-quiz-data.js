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

// Enhanced data for each quiz
const quizEnhancements = {
  'Bioma': {
    target_audience: 'Health-conscious individuals aged 35-65, particularly women struggling with weight loss, digestive issues, and low energy. Appeals to those who have tried multiple diets without success.',
    quiz_structure: `36 STEPS Total - Longest quiz analyzed
Step 1-5: Demographics & Basic Health
Step 6-15: Lifestyle & Habits Assessment  
Step 16-25: Specific Health Concerns & Goals
Step 26-30: Product Customization
Step 31-36: Contact Information & Results`,
    copy_patterns: `• Uses empathy-driven questions ("How frustrated are you with...")
• Progressive commitment (easy → personal → health)
• Visual body selection for problem areas
• Personalization through name usage
• Authority building with "doctors recommend"`,
    technical_notes: `Platform: Custom React quiz app
Mobile optimized with touch gestures
Progress bar with percentage
Auto-save functionality
Conditional logic based on answers`,
    key_insights: `• 36 steps work because of micro-commitments
• Body visualization increases engagement
• Health urgency created progressively
• Results feel highly personalized`
  },
  'Terrashell': {
    target_audience: 'Security-conscious consumers, particularly older demographics (45+) concerned about online shopping safety. Appeals to those who have been scammed or fear identity theft.',
    quiz_structure: `19 STEPS Total - Security-focused flow
Step 1-3: Device & Browser Detection
Step 4-8: Shopping Habits Assessment
Step 9-14: Security Concerns Mapping
Step 15-17: Protection Level Analysis
Step 18-19: Results & Recommendation`,
    copy_patterns: `• Fear-based messaging ("Are you protected?")
• Authority triggers (security badges)
• Urgency creation ("vulnerability detected")
• Trust signals throughout
• Technical jargon simplified`,
    technical_notes: `Platform: Proprietary quiz system
Card-based selection UI
Real-time threat detection simulation
Device fingerprinting
SSL badges prominently displayed`,
    key_insights: `• Security angle converts well
• Visual cards more engaging than radio buttons
• Fake scanning builds perceived value
• Trust signals critical for conversion`
  },
  'Mounjaro': {
    target_audience: 'Weight loss seekers familiar with GLP-1 medications (Ozempic, Wegovy). Targets those looking for alternatives due to cost or availability.',
    quiz_structure: `3 STEPS ONLY - Ultra-fast qualification
Step 1: Weight Loss Goal
Step 2: Current Medication Status
Step 3: Contact Information`,
    copy_patterns: `• Leverages trending medication names
• Minimal friction approach
• Direct benefit statements
• No fluff - straight to point
• Medical authority implied`,
    technical_notes: `Platform: Simple form-based quiz
No progress indicators needed
Single page application
Instant results promise
Mobile-first design`,
    key_insights: `• 3 steps maximize completion rate
• Brand recognition (Mounjaro) drives traffic
• Speed over personalization
• Works for high-intent traffic only`
  },
  'Magnetmind': {
    target_audience: 'Stressed professionals and anxiety sufferers aged 25-45 seeking meditation/mindfulness solutions. Appeals to beginners intimidated by traditional meditation.',
    quiz_structure: `12 STEPS - Personalization focused
Step 1-3: Stress Level Assessment
Step 4-6: Current Meditation Experience
Step 7-9: Goals & Preferences
Step 10-11: Personalization Questions
Step 12: App Recommendation`,
    copy_patterns: `• Calming language throughout
• Validates user feelings
• Scientific backing mentioned
• Personalization emphasized
• Success stories integrated`,
    technical_notes: `Platform: Modern web app
Smooth transitions between steps
Calming color scheme (blues/purples)
Audio previews embedded
App store badges displayed`,
    key_insights: `• Meditation apps need trust building
• Personalization key for app adoption
• Free trial critical for conversion
• Testimonials very effective`
  },
  'Bliz-german': {
    target_audience: 'German market - health conscious consumers seeking natural weight loss solutions. DACH region specific.',
    quiz_structure: `8 STEPS - Compact German flow
Step 1-2: Basic Demographics
Step 3-4: Weight Loss History
Step 5-6: Health Conditions
Step 7-8: Product Match`,
    copy_patterns: `• German language optimized
• Formal tone (Sie, not du)
• EU compliance messaging
• Natural ingredients emphasized
• German testimonials used`,
    technical_notes: `Platform: EU-hosted quiz system
GDPR compliance banners
German payment methods
.de domain for trust
Cookie consent integrated`,
    key_insights: `• German market prefers shorter quizzes
• Trust signals more important in DACH
• Natural/Bio messaging critical
• Local testimonials convert better`
  }
};

async function enrichQuizData() {
  console.log('🔧 Enriching quiz data...\n');
  
  const { default: fetch } = await import('node-fetch');
  
  for (const [name, enhancements] of Object.entries(quizEnhancements)) {
    console.log(`Updating ${name}...`);
    
    try {
      // First get the quiz ID
      const getResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/quiz_archive?name=eq.${name}&select=id`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          }
        }
      );
      
      const quizzes = await getResponse.json();
      if (!quizzes || quizzes.length === 0) {
        console.log(`❌ ${name} not found in database`);
        continue;
      }
      
      const quizId = quizzes[0].id;
      
      // Update with enhanced data
      const updateResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/quiz_archive?id=eq.${quizId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(enhancements)
        }
      );
      
      if (updateResponse.ok) {
        console.log(`✅ ${name} updated successfully`);
      } else {
        console.log(`❌ Failed to update ${name}:`, await updateResponse.text());
      }
      
    } catch (error) {
      console.error(`Error updating ${name}:`, error.message);
    }
  }
  
  console.log('\n✨ Enrichment complete!');
}

enrichQuizData();