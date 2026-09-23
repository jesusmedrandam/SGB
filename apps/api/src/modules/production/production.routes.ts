import { Router,type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate,requireModule,requirePermission,requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import { finishLactation,listProduction,recordMilk,recordTank,
  createLactation,setLactationMilking } from './production.service.js';
import { finishLactationSchema,idSchema,lactationSchema,milkSchema,milkingSchema,tankSchema } from './production.schemas.js';

const metadata=(request:Request):RequestMetadata=>({
  ipAddress:request.ip || null,userAgent:request.header('user-agent')?.slice(0,1000) ?? null,
});
export const productionRouter=Router();
productionRouter.use(authenticate,requirePropertyContext,requireModule('PRODUCTION'));
productionRouter.get('/',requirePermission('PRODUCTION_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listProduction(request.propertyContext!)});
}));
productionRouter.post('/lactations',requirePermission('PRODUCTION_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createLactation(request.auth!,request.propertyContext!,
    lactationSchema.parse(request.body),metadata(request))});
}));
productionRouter.post('/lactations/:id/finish',requirePermission('PRODUCTION_MANAGE'),
  asyncHandler(async(request,response)=>{
    const {id}=idSchema.parse(request.params);
    const {endedOn}=finishLactationSchema.parse(request.body);
    response.json({ok:true,data:await finishLactation(request.auth!,request.propertyContext!,
      id,endedOn,metadata(request))});
  }));
productionRouter.put('/lactations/:id/milking',requirePermission('PRODUCTION_MANAGE'),
  asyncHandler(async(request,response)=>{
    const {id}=idSchema.parse(request.params);
    const {inMilking}=milkingSchema.parse(request.body);
    response.json({ok:true,data:await setLactationMilking(request.auth!,request.propertyContext!,
      id,inMilking,metadata(request))});
  }));
productionRouter.post('/milk',requirePermission('PRODUCTION_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await recordMilk(request.auth!,request.propertyContext!,
    milkSchema.parse(request.body),metadata(request))});
}));
productionRouter.post('/tanks',requirePermission('PRODUCTION_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await recordTank(request.auth!,request.propertyContext!,
    tankSchema.parse(request.body),metadata(request))});
}));
