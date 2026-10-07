import sharp from 'sharp';
import {invalidRequest,unauthorized} from '../../core/errors.js';
import {inTransaction} from '../../database/transaction.js';
import {hashPassword,verifyPassword} from '../../security/password.js';
import type {AuthState,RequestMetadata} from './auth.types.js';

export async function updateProfile(auth:AuthState,input:{displayName:string;profilePhoto?:string|null|undefined},metadata:RequestMetadata){
  let photo=input.profilePhoto;
  if(photo){
    try{
      const original=Buffer.from(photo.slice(photo.indexOf(',')+1),'base64');
      const image=sharp(original,{limitInputPixels:16000000});
      const info=await image.metadata();
      if(!['jpeg','png','webp'].includes(info.format)||Number(info.pages??1)>1)throw new Error('Invalid image');
      const processed=await image.rotate().resize(256,256,{fit:'cover',withoutEnlargement:true})
        .webp({quality:80}).toBuffer();
      photo=`data:image/webp;base64,${processed.toString('base64')}`;
      if(photo.length>200000)throw new Error('Image too large');
    }catch{throw invalidRequest('INVALID_PROFILE_PHOTO','Elige una foto válida en formato JPG, PNG o WebP.');}
  }
  return inTransaction(async client=>{
    const before=(await client.query<{display_name:string;profile_photo_data:string|null}>(
      `SELECT u.display_name,u.profile_photo_data FROM app_user u JOIN user_session s ON s.user_id=u.id
       WHERE u.id=$1 AND s.id=$2 AND u.status='ACTIVE' AND u.deleted_at IS NULL
         AND s.revoked_at IS NULL AND s.expires_at>now() AND s.access_expires_at>now() FOR UPDATE OF u,s`,
      [auth.userId,auth.sessionId])).rows[0];
    if(!before)throw unauthorized();
    const updated=(await client.query(
      `UPDATE app_user SET display_name=$2,profile_photo_data=$3 WHERE id=$1
       RETURNING id,email,display_name AS "displayName",is_superadmin AS "isSuperadmin",profile_photo_data AS "profilePhoto"`,
      [auth.userId,input.displayName,photo===undefined?before.profile_photo_data:photo])).rows[0];
    if(before.display_name!==updated.displayName||before.profile_photo_data!==updated.profilePhoto){
      await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,action,entity_type,
        entity_id,before_data,after_data,ip_address,user_agent)
        VALUES($1,$2,$3,'USER_PROFILE_UPDATED','APP_USER',$1,$4::jsonb,$5::jsonb,$6,$7)`,
        [auth.userId,auth.activePropertyId,auth.activeRoleId,
          JSON.stringify({displayName:before.display_name,hasProfilePhoto:Boolean(before.profile_photo_data)}),
          JSON.stringify({displayName:updated.displayName,hasProfilePhoto:Boolean(updated.profilePhoto),
            profilePhotoChanged:before.profile_photo_data!==updated.profilePhoto}),metadata.ipAddress,metadata.userAgent]);
    }
    return updated;
  });
}

export async function changePassword(auth:AuthState,input:{currentPassword:string;newPassword:string},metadata:RequestMetadata){
  await inTransaction(async client=>{
    const user=(await client.query<{password_hash:string}>(
      `SELECT u.password_hash FROM app_user u JOIN user_session s ON s.user_id=u.id
       WHERE u.id=$1 AND s.id=$2 AND u.status='ACTIVE' AND u.deleted_at IS NULL
         AND s.revoked_at IS NULL AND s.expires_at>now() AND s.access_expires_at>now() FOR UPDATE OF u,s`,
      [auth.userId,auth.sessionId])).rows[0];
    if(!user)throw unauthorized();
    if(!await verifyPassword(input.currentPassword,user.password_hash))
      throw invalidRequest('CURRENT_PASSWORD_INVALID','La contraseña actual no es correcta.');
    await client.query(`UPDATE app_user SET password_hash=$2,failed_login_count=0,locked_until=NULL WHERE id=$1`,
      [auth.userId,await hashPassword(input.newPassword)]);
    await client.query(`UPDATE user_session SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`,
      [auth.userId,auth.sessionId]);
    await client.query(`UPDATE password_reset_token SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL`,[auth.userId]);
    await client.query(`INSERT INTO audit_event(actor_user_id,property_id,active_role_id,action,entity_type,
      entity_id,ip_address,user_agent) VALUES($1,$2,$3,'USER_PASSWORD_CHANGED','APP_USER',$1,$4,$5)`,
      [auth.userId,auth.activePropertyId,auth.activeRoleId,metadata.ipAddress,metadata.userAgent]);
  });
}
