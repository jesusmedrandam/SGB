import {Router,raw} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {invalidRequest} from '../../core/errors.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import {addMedia,listMedia,removeMedia,usage} from './media.service.js';

const target=z.object({entityType:z.string().max(60).regex(/^[A-Z_]+$/),entityId:z.uuid()});
const uploadTarget=target.extend({relationCode:z.string().max(60).regex(/^[A-Z_]+$/).default('GENERAL')});
const id=z.object({id:z.uuid()});
export const mediaRouter=Router();
mediaRouter.use(authenticate,requirePropertyContext,requireModule('MULTIMEDIA'));
mediaRouter.get('/usage',requirePermission('MEDIA_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await usage(req.propertyContext!)});
}));
mediaRouter.get('/',requirePermission('MEDIA_VIEW'),asyncHandler(async(req,res)=>{
  const query=z.object({entityType:z.string().max(60).regex(/^[A-Z_]+$/).optional(),
    entityId:z.uuid().optional()}).refine(value=>Boolean(value.entityType)===Boolean(value.entityId)).parse(req.query);
  res.json({ok:true,data:await listMedia(req.propertyContext!,query.entityType,query.entityId)});
}));
// Binary body avoids keeping a second multipart copy in memory. The server checks decoded content.
mediaRouter.post('/',requirePermission('MEDIA_MANAGE'),raw({type:['image/*','video/*','application/octet-stream'],
  limit:'120mb'}),asyncHandler(async(req,res)=>{
  const query=uploadTarget.parse(req.query);
  if(!Buffer.isBuffer(req.body))throw invalidRequest('MEDIA_REQUIRED','Envía un archivo de imagen o video.');
  const kind=req.header('x-media-kind')==='VIDEO'?'VIDEO':'IMAGE';
  const result=await addMedia(req.auth!,req.propertyContext!,query.entityType,query.entityId,
    query.relationCode,kind,req.body);
  res.status(201).json({ok:true,data:result});
}));
mediaRouter.delete('/:id',requirePermission('MEDIA_MANAGE'),asyncHandler(async(req,res)=>{
  await removeMedia(req.propertyContext!,id.parse(req.params).id);
  res.status(204).end();
}));
