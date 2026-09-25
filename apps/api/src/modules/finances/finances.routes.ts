import {Router,type Request} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext}
  from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {financeAccounts,financeMovements,createFinanceAccount,createFinanceMovement,
  cancelFinanceMovement,updateFinanceAccount,personalEnabled} from './finances.service.js';
const meta=(req:Request):RequestMetadata=>({ipAddress:req.ip||null,
  userAgent:req.header('user-agent')?.slice(0,1000)??null});
const amount=z.number().finite().min(0).max(999999999999.99)
  .refine(value=>/^\d+(\.\d{1,2})?$/.test(String(value)));
const account=z.object({name:z.string().trim().min(1).max(160),
  kind:z.enum(['CASH','BANK','WALLET','CREDIT_CARD','OTHER']),openingBalance:amount});
const editAccount=account.pick({name:true,kind:true}).extend({active:z.boolean()});
const movement=z.object({kind:z.enum(['INCOME','EXPENSE','TRANSFER']),
  sourceAccountId:z.uuid().nullable(),destinationAccountId:z.uuid().nullable(),
  amount:amount.positive(),occurredOn:z.iso.date(),category:z.string().trim().max(120).nullable(),
  concept:z.string().trim().min(1).max(240),notes:z.string().trim().max(3000).nullable()});
const id=z.object({id:z.uuid()});const cancel=z.object({reason:z.string().trim().min(3).max(3000)});
function routes(scope:'PROPERTY'|'PERSONAL'){
 const router=Router();router.use(authenticate);
 if(scope==='PROPERTY')router.use(requirePropertyContext,requireModule('PROPERTY_FINANCE'));
 else router.use(asyncHandler(async(req,_res,next)=>{await personalEnabled(req.auth!);next();}));
 const view=scope==='PROPERTY'?requirePermission('FINANCE_VIEW'):(_req:Request,_res:unknown,next:()=>void)=>next();
 const manage=scope==='PROPERTY'?requirePermission('FINANCE_MANAGE'):(_req:Request,_res:unknown,next:()=>void)=>next();
 router.get('/accounts',view,asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await financeAccounts(req.auth!,req.propertyContext,scope)});
 }));
 router.get('/movements',view,asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await financeMovements(req.auth!,req.propertyContext,scope)});
 }));
 router.post('/accounts',manage,asyncHandler(async(req,res)=>{
  res.status(201).json({ok:true,data:await createFinanceAccount(req.auth!,req.propertyContext,
    scope,account.parse(req.body),meta(req))});
 }));
 router.patch('/accounts/:id',manage,asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await updateFinanceAccount(req.auth!,req.propertyContext,
    scope,id.parse(req.params).id,editAccount.parse(req.body),meta(req))});
 }));
 router.post('/movements',manage,asyncHandler(async(req,res)=>{
  res.status(201).json({ok:true,data:await createFinanceMovement(req.auth!,req.propertyContext,
    scope,movement.parse(req.body),meta(req))});
 }));
 router.post('/movements/:id/cancel',manage,asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await cancelFinanceMovement(req.auth!,req.propertyContext,scope,
    id.parse(req.params).id,cancel.parse(req.body).reason,meta(req))});
 }));return router;
}
export const propertyFinancesRouter=routes('PROPERTY');
export const personalFinancesRouter=routes('PERSONAL');
