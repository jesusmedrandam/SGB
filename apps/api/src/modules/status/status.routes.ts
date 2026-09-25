import {Router} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import {listAnimalStatusEvents,listStatusOptions,recordAnimalStatus} from './status.service.js';

const input=z.object({animalId:z.uuid(),action:z.enum(['REPORT_MISSING','MARK_FOUND',
  'RECORD_DEATH','RECORD_EXIT']),reason:z.string().trim().max(3000).nullable().optional(),
  occurredAt:z.iso.datetime({offset:true}),expectedVersion:z.number().int().positive(),
  exitReasonCode:z.string().max(40).optional()});
const filters=z.object({animalId:z.uuid().optional()});

export const animalStatusRouter=Router();
animalStatusRouter.use(authenticate,requirePropertyContext);
animalStatusRouter.get('/',requirePermission('ANIMAL_VIEW'),asyncHandler(async(req,res)=>{
  const {animalId}=filters.parse(req.query);
  res.json({ok:true,data:await listAnimalStatusEvents(req.propertyContext!,animalId)});
}));
animalStatusRouter.get('/options',requirePermission('ANIMAL_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listStatusOptions(req.propertyContext!)});
}));
animalStatusRouter.post('/',requirePermission('ANIMAL_UPDATE'),asyncHandler(async(req,res)=>{
  res.status(201).json({ok:true,data:await recordAnimalStatus(req.auth!,req.propertyContext!,
    input.parse(req.body))});
}));
