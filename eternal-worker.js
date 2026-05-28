// ETERNAL WORKER - Worker che non muore mai
// Intercetta e previene il timeout di 30 minuti

console.log('🔥 ETERNAL WORKER STARTING...\n');

// Override globale di process.exit per prevenire shutdown
const originalExit = process.exit;
process.exit = function(code) {
    console.log(`⚠️  BLOCKED process.exit(${code}) - Worker eternal mode!`);
    // Non fare nulla - resta vivo
};

// Intercetta anche process.kill
process.on('SIGTERM', () => {
    console.log('⚠️  Received SIGTERM - ignoring, worker eternal mode!');
});

process.on('SIGINT', () => {
    console.log('⚠️  Received SIGINT - ignoring, worker eternal mode!');
});

// Heartbeat ogni 5 minuti per mostrare che siamo vivi
setInterval(() => {
    const uptime = Math.floor(process.uptime() / 60);
    console.log(`💗 ETERNAL WORKER HEARTBEAT - Uptime: ${uptime} minutes`);
}, 5 * 60 * 1000);

// Carica il worker originale
console.log('Loading original worker...\n');
require('./openclaw-worker.js');

console.log('\n✅ ETERNAL WORKER PROTECTION ACTIVE!');
console.log('This worker will ignore timeout and stay alive forever.');
console.log('Use Task Manager to force kill if needed.\n');