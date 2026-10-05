import {Router,raw,type Request} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../core/async-handler.js';
import {invalidRequest} from '../../core/errors.js';
import {authenticate,requireModule,requirePermission,requirePropertyContext} from '../auth/auth.middleware.js';
import {addMedia,listMedia,removeMedia,removeMediaObject,updateMediaDetails,usage} from './media.service.js';

const target=z.object({entityType:z.string().max(60).regex(/^[A-Z_]+$/),entityId:z.uuid()});
const uploadTarget=target.extend({relationCode:z.string().max(60).regex(/^[A-Z_]+$/).default('GENERAL')});
const optionalIds=z.string().max(4000).optional().transform(value=>value?value.split(','):[])
  .pipe(z.array(z.uuid()).max(100).refine(value=>new Set(value).size===value.length));
const photoUpload=z.object({animalIds:optionalIds,tagIds:optionalIds,
  description:z.string().trim().max(2000).optional(),capturedOn:z.iso.date().optional()});
const id=z.object({id:z.uuid()});
const distinctIds=z.array(z.uuid()).max(100).refine(value=>new Set(value).size===value.length);
const mediaDetails=z.object({capturedOn:z.iso.date().nullable(),description:z.string().trim().max(2000).nullable(),
  tagIds:distinctIds,animalIds:distinctIds,expectedAttachmentIds:distinctIds.min(1)});
export const mediaRouter=Router();
const metadata=(request:Request)=>({ipAddress:request.ip??null,userAgent:request.header('user-agent')?.slice(0,1000)??null});
mediaRouter.use(authenticate,requirePropertyContext,requireModule('MULTIMEDIA'));
mediaRouter.get('/usage',requirePermission('MEDIA_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await usage(req.propertyContext!)});
}));
mediaRouter.get('/',requirePermission('MEDIA_VIEW'),asyncHandler(async(req,res)=>{
  const query=z.object({entityType:z.string().max(60).regex(/^[A-Z_]+$/).optional(),
    entityId:z.uuid().optional(),page:z.coerce.number().int().min(1).max(10000).default(1)})
    .refine(value=>!value.entityId||Boolean(value.entityType)).parse(req.query);
  res.json({ok:true,data:await listMedia(req.propertyContext!,query.entityType,query.entityId,undefined,query.page)});
}));
// Binary body avoids keeping a second multipart copy in memory. The server checks decoded content.
mediaRouter.post('/',requirePermission('MEDIA_MANAGE'),raw({type:['image/*','video/*','application/octet-stream'],
  limit:'120mb'}),asyncHandler(async(req,res)=>{
  const query=uploadTarget.safeExtend(photoUpload.shape).parse(req.query);
  if(!Buffer.isBuffer(req.body))throw invalidRequest('MEDIA_REQUIRED','Envía un archivo de imagen o video.');
  const kind=req.header('x-media-kind')==='VIDEO'?'VIDEO':'IMAGE';
  const ids=query.animalIds.length?query.animalIds:[query.entityId];
  if(query.animalIds.length&&query.entityType!=='ANIMAL')throw invalidRequest('MEDIA_TARGET_INVALID',
    'Selecciona animales para una foto de animales.');
  const result=await addMedia(req.auth!,req.propertyContext!,query.entityType,query.entityId,
    query.relationCode,kind,req.body,{extraAnimalIds:ids.filter(value=>value!==query.entityId),
      tagIds:query.tagIds,description:query.description??null,capturedOn:query.capturedOn??null,metadata:metadata(req)});
  res.status(201).json({ok:true,data:result});
}));
mediaRouter.patch('/objects/:id',requirePermission('MEDIA_MANAGE'),asyncHandler(async(req,res)=>{
  const objectId=id.parse(req.params).id;
  const attachmentIds=await updateMediaDetails(req.auth!,req.propertyContext!,objectId,mediaDetails.parse(req.body),metadata(req));
  const attachments=await listMedia(req.propertyContext!,undefined,undefined,objectId);
  res.json({ok:true,data:{attachmentIds,attachments}});
}));
mediaRouter.delete('/objects/:id',requirePermission('MEDIA_MANAGE'),asyncHandler(async(req,res)=>{
  const deletedFromProvider=await removeMediaObject(req.propertyContext!,id.parse(req.params).id,req.auth!,metadata(req));
  res.json({ok:true,data:{deletedFromProvider}});
}));
mediaRouter.delete('/:id',requirePermission('MEDIA_MANAGE'),asyncHandler(async(req,res)=>{
  await removeMedia(req.propertyContext!,id.parse(req.params).id,req.auth!,metadata(req));
  res.status(204).end();
}));
