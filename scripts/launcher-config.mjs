import dotenv from 'dotenv';
dotenv.config({ quiet: true });
// Only the launcher's non-secret configuration is emitted. Never emit the API key.
console.log(JSON.stringify({
  port: process.env.PORT || '3001',
  data: process.env.DATA_DIR || './data/postgres',
  ollama: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
}));
