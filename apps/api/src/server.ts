import { app } from './app.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { env } from './config.js';
import { pool } from './database/pool.js';
import { processPendingDeletions } from './modules/media/media.service.js';

// The existing runner locks migrations and applies each pending file transactionally.
const migration=spawnSync(process.execPath,[...process.execArgv,fileURLToPath(new URL(
  import.meta.url.endsWith('.ts')?'./scripts/migrate.ts':'./scripts/migrate.js',import.meta.url))],{stdio:'inherit'});
if(migration.error)throw migration.error;
if(migration.status!==0)process.exit(migration.status??1);

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
