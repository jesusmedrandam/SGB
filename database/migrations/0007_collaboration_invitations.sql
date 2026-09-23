BEGIN;

ALTER TABLE property_invitation
  ADD COLUMN job_title varchar(140),
  ADD COLUMN pay_amount numeric(14,2) CHECK (pay_amount IS NULL OR pay_amount >= 0),
  ADD COLUMN pay_currency char(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN pay_frequency pay_frequency,
  ADD COLUMN employment_notes text,
  ADD CONSTRAINT invitation_pay_requires_job
    CHECK (pay_amount IS NULL OR job_title IS NOT NULL),
  ADD CONSTRAINT invitation_pay_requires_frequency
    CHECK (pay_amount IS NULL OR pay_frequency IS NOT NULL),
  ADD CONSTRAINT invitation_frequency_requires_pay
    CHECK (pay_frequency IS NULL OR pay_amount IS NOT NULL);

CREATE INDEX property_invitation_email_status_idx
  ON property_invitation (email, status, expires_at DESC);

CREATE OR REPLACE VIEW account_collaborator_usage AS
WITH collaborator_email AS (
  SELECT p.account_id, lower(u.email::text) AS email
  FROM property p
  JOIN administrative_account a ON a.id = p.account_id
  JOIN property_membership pm ON pm.property_id = p.id
  JOIN app_user u ON u.id = pm.user_id
  WHERE p.deleted_at IS NULL
    AND p.status <> 'ARCHIVED'
    AND pm.status IN ('INVITED', 'ACTIVE', 'SUSPENDED')
    AND pm.user_id <> a.owner_user_id

  UNION

  SELECT p.account_id, lower(pi.email::text) AS email
  FROM property p
  JOIN administrative_account a ON a.id = p.account_id
  JOIN property_invitation pi ON pi.property_id = p.id
  JOIN app_user owner_user ON owner_user.id = a.owner_user_id
  WHERE p.deleted_at IS NULL
    AND p.status <> 'ARCHIVED'
    AND pi.status = 'PENDING'
    AND pi.expires_at > now()
    AND lower(pi.email::text) <> lower(owner_user.email::text)
)
SELECT a.id AS account_id, count(ce.email)::bigint AS used_value
FROM administrative_account a
LEFT JOIN collaborator_email ce ON ce.account_id = a.id
GROUP BY a.id;

COMMIT;
