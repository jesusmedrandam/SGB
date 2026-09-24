import {Router,type Request} from 'express';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {createWeighing,listWeighingOptions,listWeighings,updateWeighing,voidWeighing} from './weighings.service.js';
import {weighingIdSchema,weighingInputSchema,weighingListSchema,weighingVersionSchema} from './weighings.schemas.js';

const metadata=(request:Request):RequestMetadata=>({ipAddress:request.ip||null,
  userAgent:request.header('user-agent')?.slice(0,1000)??null});
export const weighingsRouter=Router();
weighingsRouter.use(authenticate,requirePropertyContext,requireModule('WEIGHING'));
weighingsRouter.get('/',requirePermission('WEIGHING_VIEW'),asyncHandler(async(request,response)=>{
  const {animalId}=weighingListSchema.parse(request.query);
  response.json({ok:true,data:await listWeighings(request.propertyContext!,animalId)});
}));
weighingsRouter.get('/options',requirePermission('WEIGHING_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listWeighingOptions(request.propertyContext!)});
}));
weighingsRouter.post('/',requirePermission('WEIGHING_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createWeighing(request.auth!,request.propertyContext!,
    weighingInputSchema.parse(request.body),metadata(request))});
}));
weighingsRouter.put('/:id',requirePermission('WEIGHING_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await updateWeighing(request.auth!,request.propertyContext!,
    weighingIdSchema.parse(request.params).id,weighingInputSchema.parse(request.body),metadata(request))});
}));
weighingsRouter.post('/:id/void',requirePermission('WEIGHING_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await voidWeighing(request.auth!,request.propertyContext!,
    weighingIdSchema.parse(request.params).id,weighingVersionSchema.parse(request.body).expectedVersion,
    metadata(request))});
}));
