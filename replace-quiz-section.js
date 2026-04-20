const fs = require('fs');
const path = require('path');

// Leggi il file
const filePath = path.join(__dirname, 'src/app/templates/page.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// Trova la sezione quiz - dalla linea 1195
const startMarker = '{mainView === \'quiz\' && (() => {';
const startIndex = content.indexOf(startMarker);

if (startIndex === -1) {
  console.error('Quiz section not found!');
  process.exit(1);
}

// Trova dove finisce - dobbiamo trovare il return corrispondente
// Cerchiamo })())} che chiude questa sezione
let searchFrom = startIndex;
let parenDepth = 0;
let braceDepth = 0;
let inString = false;
let stringChar = '';
let i = startIndex;

// Skip to the opening (
while (i < content.length && content[i] !== '(') i++;
i++; // Skip the (
i++; // Skip the second (

// Now we're inside the function
for (; i < content.length; i++) {
  const char = content[i];
  const nextChar = content[i + 1];
  
  // Handle strings
  if (!inString && (char === '"' || char === '\'' || char === '`')) {
    inString = true;
    stringChar = char;
  } else if (inString && char === stringChar && content[i - 1] !== '\\') {
    inString = false;
  }
  
  if (!inString) {
    if (char === '{') braceDepth++;
    else if (char === '}') {
      braceDepth--;
      // Check if we're back at the top level
      if (braceDepth === 0) {
        // Check for )())}
        if (content.substring(i, i + 5) === '})()}') {
          const endIndex = i + 5;
          
          // Replace the entire section
          const newSection = `{mainView === 'quiz' && (
          <QuizArchiveView 
            searchTerm={archiveSearch}
            onAddNew={() => {
              setActiveTab('quiz');
              setShowAddForm(!showAddForm);
              setMainView('templates');
            }}
            onPreview={(quiz) => setPagePreview({ isOpen: true, url: quiz.url, name: quiz.name, pageType: 'quiz' })}
          />
        )}`;
          
          const newContent = content.substring(0, startIndex) + newSection + content.substring(endIndex);
          
          // Write back
          fs.writeFileSync(filePath, newContent);
          console.log('✅ Quiz section replaced successfully!');
          process.exit(0);
        }
      }
    }
  }
}

console.error('Could not find end of quiz section!');
process.exit(1);