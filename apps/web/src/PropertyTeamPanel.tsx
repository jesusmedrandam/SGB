import { FormEvent, useEffect, useState } from 'react';
import {
  ApiRequestError,
  createPropertyInvitation,
  getPropertyTeam,
  revokePropertyInvitation,
  updateMembershipStatus,
  type PropertyTeam,
} from './api';

const errorMessage = (error: unknown) => error instanceof ApiRequestError
  ? error.message
  : 'No fue posible completar la operación.';

const frequencyNames: Record<string, string> = {
  HOURLY: 'Por hora', DAILY: 'Diario', WEEKLY: 'Semanal', BIWEEKLY: 'Quincenal',
  MONTHLY: 'Mensual', OTHER: 'Otro',
};

export function PropertyTeamPanel({ accessToken }: { accessToken: string }) {
  const [team, setTeam] = useState<PropertyTeam | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setTeam(await getPropertyTeam(accessToken));
  }

  useEffect(() => {
    void load().catch((loadError) => setError(errorMessage(loadError)));
  }, [accessToken]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const roleIds = form.getAll('roleIds').map(String);
    const payValue = String(form.get('payAmount') || '').trim();
    const jobTitle = String(form.get('jobTitle') || '').trim();
    const employmentNotes = String(form.get('employmentNotes') || '').trim();
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await createPropertyInvitation(accessToken, {
        email: String(form.get('email')),
        roleIds,
        ...(jobTitle ? { jobTitle } : {}),
        payAmount: payValue ? Number(payValue) : null,
        payFrequency: payValue
          ? String(form.get('payFrequency')) as 'HOURLY' | 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'OTHER'
          : null,
        ...(employmentNotes ? { employmentNotes } : {}),
      });
      setNotice(result.delivery === 'SENT'
        ? 'Invitación enviada correctamente.'
        : 'La invitación quedó creada, pero el correo no pudo enviarse.');
      event.currentTarget.reset();
      setShowForm(false);
      await load();
    } catch (inviteError) { setError(errorMessage(inviteError)); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await revokePropertyInvitation(accessToken, id); await load(); }
    catch (revokeError) { setError(errorMessage(revokeError)); }
    finally { setBusy(false); }
  }

  async function setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED' | 'ENDED') {
    if (status === 'ENDED' && !window.confirm('¿Finalizar definitivamente esta colaboración?')) return;
    setBusy(true); setError(null); setNotice(null);
    try { await updateMembershipStatus(accessToken, id, status); await load(); }
    catch (statusError) { setError(errorMessage(statusError)); }
    finally { setBusy(false); }
  }

  if (!team) return <section className="section-block team-panel"><span className="spinner large" />
    <p className="muted">Cargando colaboradores…</p></section>;

  return <section className="section-block team-panel">
    <div className="section-heading"><div><span className="eyebrow">Accesos de la propiedad</span>
      <h2>Colaboradores</h2><p className="muted">{team.quota.used} de {team.quota.limit ?? '∞'} cupos utilizados.</p></div>
      {team.canManage && <button className="primary-button compact" type="button"
        onClick={() => setShowForm((value) => !value)}>{showForm ? 'Cerrar' : '+ Invitar'}</button>}</div>
    {error && <div className="form-error admin-error" role="alert">{error}</div>}
    {notice && <div className="form-success admin-error">{notice}</div>}

    {showForm && <form className="invite-form" onSubmit={invite}>
      <div className="field-pair">
        <label><span>Correo electrónico</span><input name="email" type="email" required disabled={busy} /></label>
        <label><span>Cargo</span><input name="jobTitle" placeholder="Ej. Vaquero, encargado" disabled={busy} /></label>
      </div>
      <fieldset><legend>Roles</legend><div className="role-options">
        {team.assignableRoles.map((role) => <label key={role.id}>
          <input name="roleIds" type="checkbox" value={role.id} />
          <span><strong>{role.name}</strong><small>{role.description}</small></span>
        </label>)}
      </div></fieldset>
      <div className="field-pair">
        <label><span>Pago en USD (opcional)</span><input name="payAmount" type="number" min="0" step="0.01" disabled={busy} /></label>
        <label><span>Frecuencia</span><select name="payFrequency" defaultValue="MONTHLY" disabled={busy}>
          {Object.entries(frequencyNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>
      <label><span>Notas laborales (opcional)</span><textarea name="employmentNotes" maxLength={2000} disabled={busy} /></label>
      <button className="primary-button" type="submit" disabled={busy || team.assignableRoles.length === 0}>
        {busy ? 'Enviando…' : 'Crear y enviar invitación'}
      </button>
    </form>}

    {team.invitations.length > 0 && <div className="team-block"><h3>Invitaciones pendientes</h3>
      {team.invitations.map((invitation) => <article className="team-row" key={invitation.id}>
        <div className="team-avatar">✉</div><div className="team-copy"><strong>{invitation.email}</strong>
          <small>{invitation.roles.map((role) => role.name).join(', ')}{invitation.jobTitle ? ` · ${invitation.jobTitle}` : ''}</small></div>
        {team.canManage && <button className="text-button danger-text" type="button" disabled={busy}
          onClick={() => revoke(invitation.id)}>Revocar</button>}
      </article>)}</div>}

    <div className="team-block"><h3>Personas con acceso</h3>{team.members.map((member) => <article className="team-row" key={member.id}>
      <div className="team-avatar">{member.displayName.slice(0, 1).toUpperCase()}</div>
      <div className="team-copy"><strong>{member.displayName}{member.isOwner ? ' · Propietario' : ''}</strong>
        <small>{member.email}</small><span>{member.roles.map((role) => role.name).join(', ')}
          {member.jobTitle ? ` · ${member.jobTitle}` : ''}</span>
        {member.payment && <span>{member.payment.currency} {member.payment.amount.toFixed(2)} · {frequencyNames[member.payment.frequency || 'OTHER']}</span>}
      </div>
      <span className={`status-pill ${member.status.toLowerCase()}`}>
        {member.status === 'ACTIVE' ? 'Activo' : 'Suspendido'}
      </span>
      {team.canManage && !member.isOwner && !member.isSelf && <div className="team-actions">
        {member.status === 'ACTIVE'
          ? <button type="button" disabled={busy} onClick={() => setStatus(member.id, 'SUSPENDED')}>Suspender</button>
          : <button type="button" disabled={busy} onClick={() => setStatus(member.id, 'ACTIVE')}>Reactivar</button>}
        <button className="danger-text" type="button" disabled={busy}
          onClick={() => setStatus(member.id, 'ENDED')}>Finalizar</button>
      </div>}
    </article>)}</div>
  </section>;
}
