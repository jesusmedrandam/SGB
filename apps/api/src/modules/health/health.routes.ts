import {Router,type Request} from 'express';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {applyCampaign,cancelCampaign,createCampaign,createMedicine,listCampaigns,
  listHealthOptions,listMedicines,updateCampaign} from './health.service.js';
import {campaignSchema,idSchema,medicineSchema} from './health.schemas.js';

const metadata=(request:Request):RequestMetadata=>({ipAddress:request.ip||null,
  userAgent:request.header('user-agent')?.slice(0,1000)??null});
export const healthRouter=Router();
healthRouter.use(authenticate,requirePropertyContext,requireModule('HEALTH'));
healthRouter.get('/medicines',requirePermission('HEALTH_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listMedicines(request.propertyContext!)});
}));
healthRouter.post('/medicines',requirePermission('HEALTH_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createMedicine(request.auth!,request.propertyContext!,
    medicineSchema.parse(request.body),metadata(request))});
}));
healthRouter.get('/options',requirePermission('HEALTH_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listHealthOptions(request.propertyContext!)});
}));
healthRouter.get('/campaigns',requirePermission('HEALTH_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listCampaigns(request.propertyContext!)});
}));
healthRouter.post('/campaigns',requirePermission('HEALTH_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createCampaign(request.auth!,request.propertyContext!,
    campaignSchema.parse(request.body),metadata(request))});
}));
healthRouter.put('/campaigns/:id',requirePermission('HEALTH_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await updateCampaign(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,campaignSchema.parse(request.body),metadata(request))});
}));
healthRouter.post('/campaigns/:id/apply',requirePermission('HEALTH_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await applyCampaign(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
healthRouter.post('/campaigns/:id/cancel',requirePermission('HEALTH_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await cancelCampaign(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
