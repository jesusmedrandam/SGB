import {Router,type Request} from 'express';
import {z} from 'zod';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import {asyncHandler} from '../../core/async-handler.js';
import {idSchema} from './movements.schemas.js';
import {externalTransferSchema,externalDecisionSchema} from './external-transfers.schemas.js';
import {acceptExternalTransfer,createExternalTransfer,decideExternalTransfer,getExternalTransferSettings,
  listExternalTransfers,lookupExternalDestination,refreshExternalTransfer,setExternalTransferSettings} from './external-transfers.service.js';

const metadata=(req:Request)=>({ipAddress:req.ip||null,userAgent:req.header('user-agent')?.slice(0,1000)??null});
export const externalTransfersRouter=Router();
externalTransfersRouter.use(authenticate,requirePropertyContext);
externalTransfersRouter.get('/settings',asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await getExternalTransferSettings(req.auth!,req.propertyContext!)});
}));
externalTransfersRouter.patch('/settings',asyncHandler(async(req,res)=>{
  const {enabled}=z.object({enabled:z.boolean()}).parse(req.body);
  res.json({ok:true,data:await setExternalTransferSettings(req.auth!,req.propertyContext!,enabled,metadata(req))});
}));
externalTransfersRouter.use(requireModule('MOVEMENTS'));
externalTransfersRouter.get('/',requirePermission('MOVEMENT_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listExternalTransfers(req.propertyContext!)});
}));
externalTransfersRouter.post('/lookup',requirePermission('MOVEMENT_MANAGE'),asyncHandler(async(req,res)=>{
  const {receiveCode}=z.object({receiveCode:z.uuid()}).parse(req.body);
  res.json({ok:true,data:await lookupExternalDestination(req.auth!,req.propertyContext!,receiveCode)});
}));
externalTransfersRouter.post('/',requirePermission('MOVEMENT_MANAGE'),requirePermission('ANIMAL_VIEW'),asyncHandler(async(req,res)=>{
  res.status(201).json({ok:true,data:await createExternalTransfer(req.auth!,req.propertyContext!,externalTransferSchema.parse(req.body),metadata(req))});
}));
externalTransfersRouter.post('/:id/accept',requirePermission('MOVEMENT_MANAGE'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await acceptExternalTransfer(req.auth!,req.propertyContext!,idSchema.parse(req.params).id,externalDecisionSchema.parse(req.body),metadata(req))});
}));
externalTransfersRouter.post('/:id/refresh',requirePermission('MOVEMENT_MANAGE'),requirePermission('ANIMAL_VIEW'),asyncHandler(async(req,res)=>{
  const {expectedVersion}=externalDecisionSchema.parse(req.body);
  res.json({ok:true,data:await refreshExternalTransfer(req.auth!,req.propertyContext!,idSchema.parse(req.params).id,expectedVersion,metadata(req))});
}));
for(const [path,decision] of [['reject','REJECTED'],['cancel','CANCELLED']] as const)
  externalTransfersRouter.post(`/:id/${path}`,requirePermission('MOVEMENT_MANAGE'),asyncHandler(async(req,res)=>{
    res.json({ok:true,data:await decideExternalTransfer(req.auth!,req.propertyContext!,idSchema.parse(req.params).id,externalDecisionSchema.parse(req.body),decision,metadata(req))});
  }));
