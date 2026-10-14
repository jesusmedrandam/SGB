import {Router,type Request} from 'express';
import {z} from 'zod';
import {rateLimit} from 'express-rate-limit';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import {asyncHandler} from '../../core/async-handler.js';
import {idSchema} from './movements.schemas.js';
import {externalTransferSchema,externalDecisionSchema,externalVisibilitySchema} from './external-transfers.schemas.js';
import {acceptExternalTransfer,createExternalTransfer,decideExternalTransfer,getExternalTransferSettings,
  listExternalTransfers,lookupExternalDestination,searchExternalDestinations,refreshExternalTransfer,setExternalTransferSettings,setExternalTransferVisibility} from './external-transfers.service.js';

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
externalTransfersRouter.patch('/visibility',requirePermission('MOVEMENT_MANAGE'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await setExternalTransferVisibility(req.auth!,req.propertyContext!,externalVisibilitySchema.parse(req.body),metadata(req))});
}));
externalTransfersRouter.get('/',requirePermission('MOVEMENT_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listExternalTransfers(req.propertyContext!)});
}));
const lookupLimiter=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,
  keyGenerator:req=>req.auth!.userId,message:{ok:false,error:{code:'EXTERNAL_LOOKUP_RATE_LIMIT',message:'Demasiadas búsquedas. Espera unos minutos.'}}});
externalTransfersRouter.post('/lookup',requirePermission('MOVEMENT_MANAGE'),lookupLimiter,asyncHandler(async(req,res)=>{
  const input=z.object({email:z.string().trim().toLowerCase().email().max(254).optional(),receiveCode:z.uuid().optional()})
    .refine(value=>Boolean(value.email)!==Boolean(value.receiveCode),'Introduce el correo del dueño.').parse(req.body);
  res.json({ok:true,data:input.email?await searchExternalDestinations(req.auth!,req.propertyContext!,input.email):
    await lookupExternalDestination(req.auth!,req.propertyContext!,input.receiveCode!)});
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
