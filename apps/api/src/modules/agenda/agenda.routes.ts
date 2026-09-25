import {Router,type Request} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requirePropertyContext} from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {agendaAction,createAgendaItem,listAgendaItems,listAgendaOptions} from './agenda.service.js';
const meta=(req:Request):RequestMetadata=>({ipAddress:req.ip||null,
  userAgent:req.header('user-agent')?.slice(0,1000)??null});
const body=z.object({kind:z.enum(['TASK','EVENT']),activityType:z.string().trim().min(2).max(60),
  title:z.string().trim().min(1).max(180),instructions:z.string().trim().max(3000).nullable(),
  scheduledAt:z.iso.datetime({offset:true}),reminderAt:z.iso.datetime({offset:true}).nullable(),
  visibility:z.enum(['PRIVATE','SELECTED','ALL']),
  userIds:z.array(z.uuid()).max(100).refine(ids=>new Set(ids).size===ids.length),
  animalIds:z.array(z.uuid()).max(100).refine(ids=>new Set(ids).size===ids.length)});
const id=z.object({id:z.uuid()});
const action=z.object({action:z.enum(['ACCEPT','DECLINE','COMPLETE','CANCEL'])});
export const agendaRouter=Router();agendaRouter.use(authenticate,requirePropertyContext);
agendaRouter.get('/',asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listAgendaItems(req.auth!,req.propertyContext!)});
}));
agendaRouter.get('/options',asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listAgendaOptions(req.propertyContext!)});
}));
agendaRouter.post('/',asyncHandler(async(req,res)=>{
  res.status(201).json({ok:true,data:await createAgendaItem(req.auth!,req.propertyContext!,
    body.parse(req.body),meta(req))});
}));
agendaRouter.post('/:id/action',asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await agendaAction(req.auth!,req.propertyContext!,
    id.parse(req.params).id,action.parse(req.body).action,meta(req))});
}));
