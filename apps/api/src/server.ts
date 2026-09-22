import { app } from './app.js';
import { env } from './config.js';
import { pool } from './database/pool.js';

const server = app.listen(env.PORT, () => {
  console.log(`SGB API escuchando en el puerto ${env.PORT}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal}: cerrando servidor.`);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
