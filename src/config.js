function parseBool(value) {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
function loadConfig(env) {
  const port = Number.parseInt(env.PORT, 10);
  return {
    port: Number.isInteger(port) ? port : 3000,
    dbHost: env.DB_HOST || 'localhost',
    dbPort: Number.parseInt(env.DB_PORT, 10) || 3306,
    dbUser: env.DB_USER || 'root',
    dbPassword: env.DB_PASSWORD || 'root123',
    dbName: env.DB_NAME || 'herwebdb',
    uploadDir: env.UPLOAD_DIR || 'uploads',
    nodeEnv: env.NODE_ENV || 'development',
  };
}
module.exports = { loadConfig };
