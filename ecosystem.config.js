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
      name: 'merlino-chat',
      script: 'merlino-chat-server.js',
      cwd: 'C:\\bot-worker',
      restart_delay: 3000,
      max_restarts: 50,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
