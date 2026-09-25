import {Router,type Request} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext}
  from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {cancelCommerce,createCommerce,listCommerce,listCommerceAnimals}
  from './commerce.service.js';

const metadata=(req:Request):RequestMetadata=>({ipAddress:req.ip||null,
  userAgent:req.header('user-agent')?.slice(0,1000)??null});
const line=z.object({animalId:z.uuid().optional(),productId:z.uuid().optional(),
  productName:z.string().trim().min(1).max(180).optional(),
  quantity:z.number().positive().max(100000000),unit:z.string().trim().min(1).max(40),
  unitPrice:z.number().min(0).max(99999999999),
  animalEffect:z.enum(['KEEP_CURRENT_PROPERTY','EXIT_CURRENT_PROPERTY']).optional()})
  .refine(value=>Boolean(value.animalId)!==Boolean(value.productId||value.productName))
  .refine(value=>!value.animalId||!value.productId)
  .refine(value=>!value.animalId||(value.quantity===1&&value.unit==='ANIMAL'))
  .refine(value=>Boolean(value.animalId)||!value.animalEffect);
const record=z.object({kind:z.enum(['SALE','PURCHASE']),tradedOn:z.iso.date(),
  buyerId:z.uuid().optional(),counterpartyName:z.string().trim().max(180).optional(),
  counterpartyContact:z.string().trim().max(180).nullable().optional(),
  destination:z.string().trim().max(240).nullable().optional(),
  notes:z.string().trim().max(3000).nullable().optional(),
  lines:z.array(line).min(1).max(100)})
  .refine(value=>value.kind==='SALE'||value.lines.every(item=>!item.animalEffect))
  .refine(value=>value.kind==='SALE'||value.lines.every(item=>!item.productId))
  .refine(value=>value.kind==='SALE'?Boolean(value.buyerId):Boolean(value.counterpartyName))
  .refine(value=>value.kind==='PURCHASE'||value.lines.every(item=>
    Boolean(item.animalId)||Boolean(item.productId)))
  .refine(value=>new Set(value.lines.flatMap(item=>item.animalId?[item.animalId]:[])).size===
    value.lines.filter(item=>item.animalId).length);
const id=z.object({id:z.uuid()});
const cancellation=z.object({reason:z.string().trim().min(3).max(3000)});
export const commerceRouter=Router();
commerceRouter.use(authenticate,requirePropertyContext,requireModule('SALES_PURCHASES'));
commerceRouter.get('/',requirePermission('COMMERCE_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listCommerce(req.propertyContext!)});
}));
commerceRouter.get('/animals',requirePermission('COMMERCE_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listCommerceAnimals(req.propertyContext!)});
}));
commerceRouter.post('/',requirePermission('COMMERCE_MANAGE'),asyncHandler(async(req,res)=>{
  res.status(201).json({ok:true,data:await createCommerce(req.auth!,req.propertyContext!,
    record.parse(req.body),metadata(req))});
}));
commerceRouter.post('/:id/cancel',requirePermission('COMMERCE_MANAGE'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await cancelCommerce(req.auth!,req.propertyContext!,
    id.parse(req.params).id,cancellation.parse(req.body).reason,metadata(req))});
}));
