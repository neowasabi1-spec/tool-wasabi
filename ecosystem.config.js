module.exports = {
  apps: [
    {
      name: 'openclaw-bridge',
      script: 'openclaw-http-bridge.js',
      cwd: 'C:\\bot-worker',
      env: {
        HTTP_PORT: 19001,
      },
      restart_delay: 3000,
      max_restarts: 50,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'cloudflare-tunnel',
      script: 'cloudflared.exe',
      args: 'tunnel --url http://localhost:19001',
      interpreter: 'none',
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
