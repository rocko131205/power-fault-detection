require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3001'),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'propel',
    user: process.env.DB_USER || 'propel',
    password: process.env.DB_PASSWORD || 'propel123',
  },
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_CHECK_INTERVAL || '30000'), // 30s
  heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT || '960000'), // 16 min
  localizationIntervalMs: parseInt(process.env.LOCALIZATION_INTERVAL || '10000'), // 10s
  scheduledOutageBufferMin: parseInt(process.env.OUTAGE_BUFFER_MIN || '40'),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
};
