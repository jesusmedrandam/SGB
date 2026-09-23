import {Router,type Request} from 'express';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {applyCleaning,cancelCleaning,createCleaning,createProduct,listCleanings,
  listCleaningOptions,listProducts,updateCleaning} from './cleanings.service.js';
import {cleaningSchema,idSchema,productSchema} from './cleanings.schemas.js';
const metadata=(request:Request):RequestMetadata=>({ipAddress:request.ip||null,
  userAgent:request.header('user-agent')?.slice(0,1000)??null});
export const cleaningsRouter=Router();
cleaningsRouter.use(authenticate,requirePropertyContext,requireModule('PASTURE_CLEANING'));
cleaningsRouter.get('/products',requirePermission('CLEANING_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listProducts(request.propertyContext!)});
}));
cleaningsRouter.post('/products',requirePermission('CLEANING_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createProduct(request.auth!,request.propertyContext!,
    productSchema.parse(request.body),metadata(request))});
}));
cleaningsRouter.get('/options',requirePermission('CLEANING_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listCleaningOptions(request.propertyContext!)});
}));
cleaningsRouter.get('/',requirePermission('CLEANING_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listCleanings(request.propertyContext!)});
}));
cleaningsRouter.post('/',requirePermission('CLEANING_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createCleaning(request.auth!,request.propertyContext!,
    cleaningSchema.parse(request.body),metadata(request))});
}));
cleaningsRouter.put('/:id',requirePermission('CLEANING_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await updateCleaning(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,cleaningSchema.parse(request.body),metadata(request))});
}));
cleaningsRouter.post('/:id/apply',requirePermission('CLEANING_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await applyCleaning(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
cleaningsRouter.post('/:id/cancel',requirePermission('CLEANING_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await cancelCleaning(request.auth!,request.propertyContext!,
    idSchema.parse(request.params).id,metadata(request))});
}));
