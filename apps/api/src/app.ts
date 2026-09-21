import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config.js';

export const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'sgb-api', version: '2.0.0-alpha.1' });
});

app.use((_request, response) => {
  response.status(404).json({ ok: false, error: 'Ruta no encontrada.' });
});
