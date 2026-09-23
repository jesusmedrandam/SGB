import {Router,type Request} from 'express';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {applyActivity,cancelActivity,createActivity,listActivities,listActivityOptions,
  updateActivity} from './activities.service.js';
import {activitySchema,idSchema} from './activities.schemas.js';
const metadata=(request:Request):RequestMetadata=>({ipAddress:request.ip||null,
  userAgent:request.header('user-agent')?.slice(0,1000)??null});
export const activitiesRouter=Router();
activitiesRouter.use(authenticate,requirePropertyContext,requireModule('TASKS'));
activitiesRouter.get('/',requirePermission('ACTIVITY_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listActivities(request.propertyContext!)});
}));
activitiesRouter.get('/options',requirePermission('ACTIVITY_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listActivityOptions(request.propertyContext!)});
}));
activitiesRouter.post('/',requirePermission('ACTIVITY_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createActivity(request.auth!,request.propertyContext!,
    activitySchema.parse(request.body),metadata(request))});
}));
activitiesRouter.put('/:id',requirePermission('ACTIVITY_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await updateActivity(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,activitySchema.parse(request.body),metadata(request))});
}));
activitiesRouter.post('/:id/apply',requirePermission('ACTIVITY_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await applyActivity(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
activitiesRouter.post('/:id/cancel',requirePermission('ACTIVITY_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await cancelActivity(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
