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
import { healthRouter } from './modules/health/health.routes.js';
import { cleaningsRouter } from './modules/cleanings/cleanings.routes.js';
import { activitiesRouter } from './modules/activities/activities.routes.js';
import { mediaRouter } from './modules/media/media.routes.js';
import { weighingsRouter } from './modules/weighings/weighings.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { animalStatusRouter } from './modules/status/status.routes.js';
import { commerceRouter } from './modules/commerce/commerce.routes.js';
import { agendaRouter } from './modules/agenda/agenda.routes.js';
import {propertyFinancesRouter,personalFinancesRouter}
  from './modules/finances/finances.routes.js';
import {notificationsRouter} from './modules/notifications/notifications.routes.js';

export const app = express();

app.disable('x-powered-by');
if (env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true,
  exposedHeaders: ['etag', 'x-idempotent-replay'] }));
app.use(requestId);
app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  if (request.method === 'GET') {
    // The private browser/WebView cache keeps the last payload and validates its ETag.
    // Unchanged records therefore return 304 without downloading the JSON again.
    response.setHeader('cache-control', 'private, no-cache');
    response.vary('authorization');
  }
  next();
});

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'sgb-api', version: '2.0.0-alpha.1',
    capabilities:['superadmin-support','media-details','selective-offline-media','explicit-support-mode','medicine-weight-dose','medicine-classification-dose','pasture-occupation-history'] });
});

app.get('/health/ready', asyncHandler(async (_request, response) => {
  const result=await pool.query<{support_ready:boolean;support_modes_ready:boolean;medicine_doses_ready:boolean;medicine_classification_doses_ready:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgname='audit_event_mark_superadmin' AND NOT tgisinternal
  ) AS support_ready,EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_session' AND column_name='support_mode') AS support_modes_ready,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='health_medicine'
      AND column_name='dose_weight') AS medicine_doses_ready,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='health_medicine'
      AND column_name='dose_classification_ranges') AS medicine_classification_doses_ready`);
  response.json({ ok: true, database: 'ready',supportReady:result.rows[0]?.support_ready===true,
    supportModesReady:result.rows[0]?.support_modes_ready===true,medicineDosesReady:result.rows[0]?.medicine_doses_ready===true,
    medicineClassificationDosesReady:result.rows[0]?.medicine_classification_doses_ready===true });
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
app.use('/health-records', healthRouter);
app.use('/cleanings', cleaningsRouter);
app.use('/activities', activitiesRouter);
app.use('/media', mediaRouter);
app.use('/weighings', weighingsRouter);
app.use('/animal-status', animalStatusRouter);
app.use('/commerce', commerceRouter);
app.use('/agenda', agendaRouter);
app.use('/finances/property', propertyFinancesRouter);
app.use('/finances/personal', personalFinancesRouter);
app.use('/notifications', notificationsRouter);
app.use('/audit', auditRouter);
app.use(notFoundHandler);
app.use(errorHandler);
