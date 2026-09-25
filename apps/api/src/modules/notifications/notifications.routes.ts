import {Router} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {pool} from '../../database/pool.js';
import {authenticate} from '../auth/auth.middleware.js';
const id=z.object({id:z.uuid()});
export const notificationsRouter=Router();notificationsRouter.use(authenticate);
notificationsRouter.get('/',asyncHandler(async(req,res)=>{
  const rows=(await pool.query(`SELECT n.id,n.kind,n.title,n.message,
    n.agenda_item_id AS "agendaItemId",n.property_id AS "propertyId",
    p.name AS "propertyName",n.read_at AS "readAt",n.created_at AS "createdAt"
    FROM app_notification n JOIN property p ON p.id=n.property_id
    WHERE n.user_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 100`,[req.auth!.userId])).rows;
  res.json({ok:true,data:rows});
}));
notificationsRouter.post('/read-all',asyncHandler(async(req,res)=>{
  await pool.query(`UPDATE app_notification SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`,
    [req.auth!.userId]);res.json({ok:true,data:{read:true}});
}));
notificationsRouter.post('/:id/read',asyncHandler(async(req,res)=>{
  await pool.query(`UPDATE app_notification SET read_at=now()
    WHERE id=$1 AND user_id=$2 AND read_at IS NULL`,[id.parse(req.params).id,req.auth!.userId]);
  res.json({ok:true,data:{read:true}});
}));
