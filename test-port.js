const net = require('net');
const socket = new net.Socket();
socket.setTimeout(10000);
socket.on('connect', () => { console.log('PORT 19001 OPEN'); socket.destroy(); });
socket.on('timeout', () => { console.log('PORT 19001 TIMEOUT (firewall?)'); socket.destroy(); });
socket.on('error', (e) => { console.log('PORT 19001 ERROR:', e.message); });
socket.connect(19001, '69.197.168.23');
