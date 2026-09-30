CREATE TABLE idempotent_mutation (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_method text NOT NULL,
  request_path text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'COMPLETED')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX idempotent_mutation_expiry_idx
  ON idempotent_mutation (expires_at);

COMMENT ON TABLE idempotent_mutation IS
  'Evita duplicados al reintentar escrituras desde clientes con conectividad intermitente.';
