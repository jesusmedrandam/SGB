import {Router} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {pool} from '../../database/pool.js';
import {authenticate,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';

const querySchema=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),
  action:z.string().trim().max(120).optional()});
export const auditRouter=Router();
auditRouter.use(authenticate,requirePropertyContext,requirePermission('AUDIT_VIEW'));
auditRouter.get('/',asyncHandler(async(request,response)=>{
  const {page,action}=querySchema.parse(request.query);
  const propertyId=request.propertyContext!.propertyId;
  const {rows}=await pool.query(`SELECT ev.id,ev.occurred_at AS "occurredAt",
    ev.action,ev.entity_type AS "entityType",ev.entity_id AS "entityId",
    ev.reason,ev.before_data AS "beforeData",ev.after_data AS "afterData",
    ev.ip_address::text AS "ipAddress",ev.user_agent AS "userAgent",
    u.display_name AS "actorName"
    FROM audit_event ev LEFT JOIN app_user u ON u.id=ev.actor_user_id
    WHERE ev.property_id=$1 AND ($2::text IS NULL OR ev.action=$2)
    ORDER BY ev.occurred_at DESC,ev.id DESC LIMIT 201 OFFSET $3`,
    [propertyId,action??null,(page-1)*200]);
  response.json({ok:true,data:{items:rows.slice(0,200),page,hasMore:rows.length>200}});
}));
