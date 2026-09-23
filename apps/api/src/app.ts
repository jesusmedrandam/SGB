import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config.js';
import { asyncHandler } from './core/async-handler.js';
import { errorHandler, notFoundHandler } from './core/error-handler.js';
import { pool } from './database/pool.js';
import { requestId } from './middleware/request-id.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { animalsRouter } from './modules/animals/animals.routes.js';
import { brandsRouter } from './modules/animals/brands.routes.js';
import { ownersRouter } from './modules/animals/owners.routes.js';
import { groupsRouter, locationsRouter } from './modules/groups/groups.routes.js';
import { catalogsRouter } from './modules/catalogs/catalogs.routes.js';
import { invitationRouter, propertyTeamRouter } from './modules/collaboration/collaboration.routes.js';
import { ownAccountRouter, propertySettingsRouter } from './modules/properties/properties.routes.js';
import { superadminRouter } from './modules/superadmin/superadmin.routes.js';
import { reproductionRouter } from './modules/reproduction/reproduction.routes.js';
import { productionRouter } from './modules/production/production.routes.js';
import { movementsRouter } from './modules/movements/movements.routes.js';

export const app = express();

app.disable('x-powered-by');
if (env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(requestId);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'sgb-api', version: '2.0.0-alpha.1' });
});

app.get('/health/ready', asyncHandler(async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ ok: true, database: 'ready' });
}));

app.use('/auth', authRouter);
app.use('/animals', animalsRouter);
app.use('/animal-brands', brandsRouter);
app.use('/owners', ownersRouter);
app.use('/groups', groupsRouter);
app.use('/locations', locationsRouter);
app.use('/invitations', invitationRouter);
app.use('/property-team', propertyTeamRouter);
app.use('/my-account', ownAccountRouter);
app.use('/property-settings', propertySettingsRouter);
app.use('/catalogs', catalogsRouter);
app.use('/superadmin', superadminRouter);
app.use('/reproduction', reproductionRouter);
app.use('/production', productionRouter);
app.use('/movements', movementsRouter);
app.use(notFoundHandler);
app.use(errorHandler);
