import {Router,type Request} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {authenticate,requirePropertyContext} from '../auth/auth.middleware.js';
import type {RequestMetadata} from '../auth/auth.types.js';
import {agendaAction,listAgendaItems,listAgendaOptions} from './agenda.service.js';
import {agendaCalendar,calendarOptions,createSharedAgenda,calendarAction} from './calendar.service.js';
import {moonPhases} from './moon.service.js';
import {weatherForecast,weatherQuery} from './weather.service.js';
import {offlineCalendar} from './offline-calendar.service.js';
const meta=(req:Request):RequestMetadata=>({ipAddress:req.ip||null,
  userAgent:req.header('user-agent')?.slice(0,1000)??null});
const body=z.object({kind:z.enum(['TASK','EVENT']),activityType:z.string().trim().min(2).max(60),
  title:z.string().trim().min(1).max(180),instructions:z.string().trim().max(3000).nullable(),
  scheduledAt:z.iso.datetime({offset:true}),reminderAt:z.iso.datetime({offset:true}).nullable(),
  visibility:z.enum(['PRIVATE','SELECTED','ALL']),
  userIds:z.array(z.uuid()).max(100).refine(ids=>new Set(ids).size===ids.length),
  animalIds:z.array(z.uuid()).max(100).refine(ids=>new Set(ids).size===ids.length),
  propertyIds:z.array(z.uuid()).min(1).max(100).refine(ids=>new Set(ids).size===ids.length).optional()});
const id=z.object({id:z.uuid()});
const calendarQuery=z.object({from:z.iso.datetime({offset:true}),to:z.iso.datetime({offset:true}),propertyId:z.uuid().optional()})
 .refine(q=>Date.parse(q.to)>Date.parse(q.from)&&Date.parse(q.to)-Date.parse(q.from)<=400*86400000);
const action=z.object({action:z.enum(['ACCEPT','DECLINE','COMPLETE','CANCEL'])});
export const agendaRouter=Router();agendaRouter.use(authenticate,requirePropertyContext);
agendaRouter.get('/',asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listAgendaItems(req.auth!,req.propertyContext!)});
}));
agendaRouter.get('/calendar',asyncHandler(async(req,res)=>{
 res.json({ok:true,data:await agendaCalendar(req.auth!,req.propertyContext!,calendarQuery.parse(req.query))});
}));
agendaRouter.get('/offline',asyncHandler(async(req,res)=>{
 res.json({ok:true,data:await offlineCalendar(req.auth!,req.propertyContext!)});
}));
agendaRouter.get('/weather',asyncHandler(async(req,res)=>{
 res.json({ok:true,data:await weatherForecast(weatherQuery.parse(req.query))});
}));
agendaRouter.get('/calendar-options',asyncHandler(async(req,res)=>{
 res.json({ok:true,data:await calendarOptions(req.auth!,req.propertyContext!)});
}));
agendaRouter.get('/moon',asyncHandler(async(req,res)=>{
 const {year}=z.object({year:z.coerce.number().int().min(1700).max(2099)}).parse(req.query);
 res.json({ok:true,data:await moonPhases(year)});
}));
agendaRouter.get('/options',asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await listAgendaOptions(req.propertyContext!)});
}));
agendaRouter.post('/',asyncHandler(async(req,res)=>{
  res.status(201).json({ok:true,data:await createSharedAgenda(req.auth!,req.propertyContext!,
    body.parse(req.body),meta(req))});
}));
agendaRouter.post('/:id/action',asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await agendaAction(req.auth!,req.propertyContext!,
    id.parse(req.params).id,action.parse(req.body).action,meta(req))});
}));

agendaRouter.post('/:id/calendar-action',asyncHandler(async(req,res)=>{
 const input=action.extend({propertyId:z.uuid()}).parse(req.body);
 res.json({ok:true,data:await calendarAction(req.auth!,req.propertyContext!,input.propertyId,id.parse(req.params).id,input.action,meta(req))});
}));
