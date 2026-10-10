import {ApiError} from './errors.js';
import {pool} from '../database/pool.js';
export function requireLiveDraft(row:{expired:boolean}){
 if(row.expired)throw new ApiError(410,'DRAFT_EXPIRED','Este borrador se eliminó al cumplir 24 horas sin aplicarse.');
}
export async function expireDrafts(){return Number((await pool.query('SELECT expire_unapplied_drafts() AS total')).rows[0].total);}
