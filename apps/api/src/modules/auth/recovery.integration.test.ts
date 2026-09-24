import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {pool} from '../../database/pool.js';
import {issueToken} from '../../security/tokens.js';
import {login,register,requestPasswordReset,resetPassword,resendEmailVerification,
  verifyEmail} from './auth.service.js';

const metadata={ipAddress:'127.0.0.1',userAgent:'sgb-recovery-test'};
test('la recuperación no enumera cuentas, consume el enlace y revoca sesiones',async()=>{
  const suffix=randomUUID();const email=`recovery-${suffix}@example.test`;
  const original='Clave-segura-2026';const replacement='Otra-clave-segura-2026';
  try{
    const registration=await register({email,password:original,displayName:'Prueba recuperación',
      propertyName:`Finca ${suffix}`},metadata);
    await pool.query(`UPDATE email_verification_token SET created_at=now()-interval '2 minutes'
      WHERE user_id=$1`,[registration.userId]);
    await verifyEmail((await resendEmailVerification(email,metadata)).verificationToken!,metadata);
    const session=await login({email,password:original,deviceId:`recovery-${suffix}`},metadata);
    await requestPasswordReset(`unknown-${suffix}@example.test`,metadata);
    await requestPasswordReset(email,metadata);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM password_reset_token
      WHERE user_id=$1`,[registration.userId])).rows[0].count,1);
    const token=issueToken('reset');
    await pool.query(`INSERT INTO password_reset_token(user_id,token_hash,expires_at)
      VALUES($1,$2,now()+interval '30 minutes')`,[registration.userId,token.hash]);
    await resetPassword(token.value,replacement,metadata);
    assert.equal((await pool.query(`SELECT revoked_at IS NOT NULL AS revoked FROM user_session
      WHERE id=$1`,[session.sessionId])).rows[0].revoked,true);
    await assert.rejects(()=>resetPassword(token.value,replacement,metadata));
    await assert.rejects(()=>login({email,password:original,deviceId:`old-${suffix}`},metadata));
    const renewed=await login({email,password:replacement,deviceId:`new-${suffix}`},metadata);
    assert.equal(renewed.user.email,email);
  }finally{await pool.end();}
});
