import { app } from './app.js';
import { env } from './config.js';
import { pool } from './database/pool.js';
import { processPendingDeletions } from './modules/media/media.service.js';

const server = app.listen(env.PORT, () => {
  console.log(`SGB API escuchando en el puerto ${env.PORT}`);
});
const deletionTimer=setInterval(()=>{
  void processPendingDeletions().catch(error=>console.error('Reintento multimedia:',error));
},10*60*1000);
deletionTimer.unref();
void processPendingDeletions().catch(error=>console.error('Reintento multimedia:',error));

const shutdown = (signal: string) => {
  clearInterval(deletionTimer);
  console.log(`${signal}: cerrando servidor.`);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
