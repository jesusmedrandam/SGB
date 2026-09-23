import {Router,type Request} from 'express';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {applyMovement,cancelMovement,createMovement,listMovementOptions,listMovements,
  updateMovement} from './movements.service.js';
import {idSchema,movementSchema} from './movements.schemas.js';

const metadata=(request:Request):RequestMetadata=>({ipAddress:request.ip||null,
  userAgent:request.header('user-agent')?.slice(0,1000)??null});
export const movementsRouter=Router();
movementsRouter.use(authenticate,requirePropertyContext,requireModule('MOVEMENTS'));
movementsRouter.get('/',requirePermission('MOVEMENT_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listMovements(request.propertyContext!)});
}));
movementsRouter.get('/options',requirePermission('MOVEMENT_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listMovementOptions(request.auth!,request.propertyContext!)});
}));
movementsRouter.post('/',requirePermission('MOVEMENT_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createMovement(request.auth!,request.propertyContext!,
    movementSchema.parse(request.body),metadata(request))});
}));
movementsRouter.put('/:id',requirePermission('MOVEMENT_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await updateMovement(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,movementSchema.parse(request.body),metadata(request))});
}));
movementsRouter.post('/:id/apply',requirePermission('MOVEMENT_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await applyMovement(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
movementsRouter.post('/:id/cancel',requirePermission('MOVEMENT_CANCEL'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await cancelMovement(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
