import type {PoolClient} from 'pg';
import {ApiError,conflict,invalidRequest,unauthorized} from '../../core/errors.js';
import {pool} from '../../database/pool.js';
import {inTransaction} from '../../database/transaction.js';
import {verifyPassword} from '../../security/password.js';
import {hashToken,issueToken} from '../../security/tokens.js';
import {sendEmailChangeConfirmation,sendEmailChangedNotice} from '../../services/email.service.js';
import type {AuthState,RequestMetadata} from './auth.types.js';
import {lockOwnProfile} from './profile.service.js';

async function audit(client:PoolClient,auth:AuthState,metadata:RequestMetadata,action:string,after:unknown){
  await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,action,entity_type,
    entity_id,after_data,ip_address,user_agent) VALUES($1::uuid,$2,$3,$4,'APP_USER',$1::text,$5::jsonb,$6,$7)`,
    [auth.userId,auth.activePropertyId,auth.activeRoleId,action,JSON.stringify(after),metadata.ipAddress,metadata.userAgent]);
}
export async function requestEmailChange(auth:AuthState,input:{email:string;currentPassword:string},metadata:RequestMetadata){
  const token=issueToken('verify');const expiresAt=new Date(Date.now()+60*60*1000);
  const user=await inTransaction(async client=>{
    const user=await lockOwnProfile(client,auth);
    if(!await verifyPassword(input.currentPassword,user.password_hash))
      throw invalidRequest('CURRENT_PASSWORD_INVALID','La contraseña actual no es correcta.');
    if(user.email.toLowerCase()===input.email.toLowerCase())
      throw invalidRequest('EMAIL_UNCHANGED','Escribe un correo diferente al actual.');
    if((await client.query('SELECT 1 FROM app_user WHERE email=$1',[input.email])).rowCount)
      throw conflict('EMAIL_UNAVAILABLE','Este correo no está disponible.');
    await client.query('UPDATE email_change_token SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[auth.userId]);
    await client.query(`INSERT INTO email_change_token(user_id,previous_email,new_email,token_hash,expires_at)
      VALUES($1,$2,$3,$4,$5)`,[auth.userId,user.email,input.email,token.hash,expiresAt]);
    await audit(client,auth,metadata,'USER_EMAIL_CHANGE_REQUESTED',{newEmail:input.email});
    return user;
  });
  const delivery=await sendEmailChangeConfirmation({email:input.email,displayName:user.display_name,token:token.value,expiresAt});
  if(delivery!=='SENT'){
    await pool.query('UPDATE email_change_token SET consumed_at=now() WHERE token_hash=$1',[token.hash]);
    throw new ApiError(503,'EMAIL_DELIVERY_FAILED','No se pudo enviar el correo de confirmación. Inténtalo más tarde.');
  }
  return {accepted:true,expiresAt};
}
export async function confirmEmailChange(token:string,metadata:RequestMetadata){
  try{
    const changed=await inTransaction(async client=>{
      const candidate=(await client.query<{user_id:string}>('SELECT user_id FROM email_change_token WHERE token_hash=$1',[hashToken(token)])).rows[0];
      if(!candidate)throw unauthorized('El enlace no es válido o venció.');
      const user=(await client.query<{email:string;display_name:string}>(
        `SELECT email::text,display_name FROM app_user WHERE id=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE`,[candidate.user_id])).rows[0];
      const pending=(await client.query<{new_email:string;previous_email:string}>(
        `SELECT new_email::text,previous_email::text FROM email_change_token WHERE token_hash=$1
         AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,[hashToken(token)])).rows[0];
      if(!user||!pending||user.email.toLowerCase()!==pending.previous_email.toLowerCase())
        throw unauthorized('El enlace no es válido o venció.');
      await client.query('UPDATE app_user SET email=$2,email_verified_at=now() WHERE id=$1',[candidate.user_id,pending.new_email]);
      await client.query('UPDATE email_change_token SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[candidate.user_id]);
      await client.query('UPDATE password_reset_token SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[candidate.user_id]);
      await client.query('UPDATE user_session SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[candidate.user_id]);
      await audit(client,{userId:candidate.user_id,sessionId:'',email:user.email,displayName:user.display_name,
        isSuperadmin:false,activePropertyId:null,activeRoleId:null},metadata,'USER_EMAIL_CHANGED',
        {previousEmail:user.email,newEmail:pending.new_email});
      return {...user,newEmail:pending.new_email};
    });
    await sendEmailChangedNotice({email:changed.email,displayName:changed.display_name,newEmail:changed.newEmail});
  }catch(error){
    if((error as {code?:string}).code==='23505')throw conflict('EMAIL_UNAVAILABLE','Este correo ya no está disponible. Solicita otro cambio.');
    throw error;
  }
}
function deviceName(name:string|null,agent:string|null){
  if(name)return name;
  const platform=/Android/i.test(agent??'')?'Android':/iPhone|iPad/i.test(agent??'')?'iPhone / iPad':
    /Windows/i.test(agent??'')?'Windows':/Macintosh/i.test(agent??'')?'Mac':'Dispositivo';
  const browser=/Edg\//.test(agent??'')?'Edge':/Chrome\//.test(agent??'')?'Chrome':/Firefox\//.test(agent??'')?'Firefox':
    /Safari\//.test(agent??'')?'Safari':'SGB';
  return `${platform} · ${browser}`;
}
export async function listOwnSessions(auth:AuthState){
  const rows=(await pool.query<{id:string;device_name:string|null;user_agent:string|null;created_at:Date;last_seen_at:Date;expires_at:Date}>(
    `SELECT id,device_name,user_agent,created_at,last_seen_at,expires_at FROM user_session
     WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY (id=$2) DESC,last_seen_at DESC`,[auth.userId,auth.sessionId])).rows;
  return rows.map(row=>({id:row.id,deviceName:deviceName(row.device_name,row.user_agent),current:row.id===auth.sessionId,
    createdAt:row.created_at,lastSeenAt:row.last_seen_at,expiresAt:row.expires_at}));
}
export async function revokeOwnSessions(auth:AuthState,id:string|null,metadata:RequestMetadata){
  return inTransaction(async client=>{
    await lockOwnProfile(client,auth);
    const removed=await client.query(`UPDATE user_session SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL
      AND ${id?'id=$2':'id<>$2'} RETURNING id`,[auth.userId,id??auth.sessionId]);
    if(id&&!removed.rowCount)throw new ApiError(404,'SESSION_NOT_FOUND','La sesión ya no está activa o no pertenece a tu cuenta.');
    await audit(client,auth,metadata,'USER_SESSIONS_REVOKED',{sessionCount:removed.rowCount,currentSessionClosed:id===auth.sessionId});
    return {closed:removed.rowCount??0,currentSessionClosed:id===auth.sessionId};
  });
}
