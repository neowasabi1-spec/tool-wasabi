const fs = require('fs');
const path = require('path');

// Leggi il file
const filePath = path.join(__dirname, 'src/app/templates/page.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// Trova l'inizio della sezione quiz
const quizSectionStart = content.indexOf('{mainView === \'quiz\' && (() => {');
if (quizSectionStart === -1) {
  console.error('Quiz section not found!');
  process.exit(1);
}

// Trova la fine - cerca la chiusura })()}
let depth = 0;
let i = quizSectionStart;
let foundEnd = false;
let quizSectionEnd = -1;

// Skip to the first {
while (i < content.length && content[i] !== '{') i++;

// Now track braces
while (i < content.length) {
  if (content[i] === '{') {
    depth++;
  } else if (content[i] === '}') {
    depth--;
    if (depth === 0) {
      // Check if this is followed by )()}
      if (content.substring(i, i + 5) === '})()}') {
        quizSectionEnd = i + 5;
        foundEnd = true;
        break;
      }
    }
  }
  i++;
}

if (!foundEnd) {
  console.error('Could not find end of quiz section!');
  process.exit(1);
}

// Replace the section
const beforeQuiz = content.substring(0, quizSectionStart);
const afterQuiz = content.substring(quizSectionEnd);

const newQuizSection = `{mainView === 'quiz' && (
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

const newContent = beforeQuiz + newQuizSection + afterQuiz;

// Write the updated file
fs.writeFileSync(filePath, newContent);
console.log('✅ Quiz section replaced successfully!');