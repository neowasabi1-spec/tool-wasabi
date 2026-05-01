export function smartReplaceHTML(html: string, productName: string): string {
  const replacements = [
    // Prodotto
    { from: /Nooro™?/gi, to: productName },
    { from: /NMES Foot Massager/gi, to: 'Audio Program' },
    { from: /Foot Massager/gi, to: 'Audio Program' },
    
    // Problemi/soluzioni
    { from: /foot pain/gi, to: 'excess weight' },
    { from: /feet pain/gi, to: 'weight issues' },
    { from: /foot overpronation/gi, to: 'metabolic imbalance' },
    { from: /feet Roll Inward/gi, to: 'metabolism slows down' },
    { from: /Feet Roll Inward/gi, to: 'Metabolism Slows Down' },
    { from: /overpronation/gi, to: 'slow metabolism' },
    
    // Tech
    { from: /NMES technology/gi, to: 'sound frequency technology' },
    { from: /NeuroMuscular Electrical Stimulation/gi, to: 'Metabolic Activation Frequencies' },
    { from: /electrical stimulation/gi, to: 'audio frequencies' },
    { from: /electrical impulses/gi, to: 'sound waves' },
    { from: /Electric Massage/gi, to: 'Audio Activation' },
    
    // Body
    { from: /your feet/gi, to: 'your metabolism' },
    { from: /feet/gi, to: 'body' },
    { from: /foot/gi, to: 'metabolic' },
    
    // Pros
    { from: /Physical Therapist/gi, to: 'Nutrition Expert' },
    { from: /podiatrist/gi, to: 'weight loss specialist' },
    { from: /Dr\. Jeremy Campbell/gi, to: 'Dr. Sarah Mitchell' },
    
    // Results
    { from: /90% improvement/gi, to: '81% weight loss' },
    { from: /pain relief/gi, to: 'weight loss' },
    { from: /relieve pain/gi, to: 'lose weight' },
    
    // URLs
    { from: /nooro-us\.com/gi, to: 'metabolicwave.com' },
    { from: /support@nooro-us\.com/gi, to: 'support@metabolicwave.com' },
    { from: /try\.nooro-us\.com/gi, to: 'get.metabolicwave.com' },
    { from: /\/review\/nooro-us\.com/gi, to: '/review/metabolicwave.com' },
    
    // Phone
    { from: /212-444-3144/g, to: '1-800-METABOLIC' }
  ];
  
  let result = html;
  
  replacements.forEach(({ from, to }) => {
    if (from.flags.includes('i')) {
      result = result.replace(from, (match) => {
        if (match[0] === match[0].toUpperCase()) {
          return to.charAt(0).toUpperCase() + to.slice(1);
        }
        return to;
      });
    } else {
      result = result.replace(from, to);
    }
  });
  
  // Fix UPDATE
  result = result.replace(/UPDATE:<\/span><\/b> ([^<]+) is SELLING OUT/gi, 
    `ALERT:</span></b> ${productName} spots are filling up rapidly`);
  
  // Clean (claude)
  result = result.replace(new RegExp(`${productName}\\s*\\([^)]+\\)`, 'gi'), productName);
  
  return result;
}