BEGIN;

CREATE TABLE account_reproduction_setting (
  account_id uuid PRIMARY KEY REFERENCES administrative_account(id),
  days_after_birth_heat integer NOT NULL DEFAULT 30 CHECK(days_after_birth_heat BETWEEN 0 AND 365),
  days_after_birth_pregnancy integer NOT NULL DEFAULT 45 CHECK(days_after_birth_pregnancy BETWEEN 0 AND 365),
  days_after_loss_heat integer NOT NULL DEFAULT 21 CHECK(days_after_loss_heat BETWEEN 0 AND 365),
  days_after_loss_pregnancy integer NOT NULL DEFAULT 30 CHECK(days_after_loss_pregnancy BETWEEN 0 AND 365),
  minimum_cow_months integer NOT NULL DEFAULT 12 CHECK(minimum_cow_months BETWEEN 0 AND 120),
  minimum_bull_months integer NOT NULL DEFAULT 12 CHECK(minimum_bull_months BETWEEN 0 AND 120),
  allow_second_heat boolean NOT NULL DEFAULT true,
  allow_false_heat_in_pregnancy boolean NOT NULL DEFAULT true,
  use_last_valid_heat boolean NOT NULL DEFAULT true,
  max_milking_days integer NOT NULL DEFAULT 305 CHECK(max_milking_days BETWEEN 1 AND 730),
  updated_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO account_reproduction_setting(account_id,days_after_birth_heat,days_after_birth_pregnancy,days_after_loss_heat,days_after_loss_pregnancy,minimum_cow_months,minimum_bull_months,allow_second_heat,allow_false_heat_in_pregnancy,use_last_valid_heat,max_milking_days,updated_by,updated_at)
SELECT DISTINCT ON(p.account_id) p.account_id,s.days_after_birth_heat,s.days_after_birth_pregnancy,s.days_after_loss_heat,s.days_after_loss_pregnancy,s.minimum_cow_months,s.minimum_bull_months,s.allow_second_heat,s.allow_false_heat_in_pregnancy,s.use_last_valid_heat,s.max_milking_days,s.updated_by,s.updated_at
FROM reproduction_setting s JOIN property p ON p.id=s.property_id
ORDER BY p.account_id,s.updated_at DESC,s.property_id;

CREATE OR REPLACE FUNCTION validate_milk_production() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM animal a JOIN milk_animal_state ms ON ms.cow_id=a.id
    LEFT JOIN account_reproduction_setting s ON s.account_id=a.account_id
    WHERE a.id=NEW.cow_id AND a.account_id=NEW.account_id AND a.property_id=NEW.property_id
      AND a.sex='FEMALE' AND a.record_status='CURRENT' AND a.availability_status_code='ACTIVE'
      AND ms.enabled AND ms.account_id=NEW.account_id AND ms.property_id=NEW.property_id
      AND EXISTS(SELECT 1 FROM reproduction_birth b WHERE b.mother_id=a.id
        AND b.property_id=a.property_id AND NEW.produced_on BETWEEN b.occurred_on
          AND b.occurred_on+COALESCE(s.max_milking_days,305)))
    OR (NEW.lactation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM milk_lactation l
      WHERE l.id=NEW.lactation_id AND l.cow_id=NEW.cow_id
        AND l.account_id=NEW.account_id AND l.property_id=NEW.property_id
        AND l.in_milking AND NEW.produced_on>=l.started_on
        AND (l.ended_on IS NULL OR NEW.produced_on<=l.ended_on)))
    OR (NEW.lactation_id IS NULL AND EXISTS (SELECT 1 FROM milk_lactation l
      WHERE l.cow_id=NEW.cow_id AND l.property_id=NEW.property_id AND l.ended_on IS NULL)) THEN
    RAISE EXCEPTION 'La vaca debe estar en ordeño tras un parto reciente.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE reproduction_birth ADD COLUMN kind text NOT NULL DEFAULT 'NORMAL' CHECK(kind IN ('NORMAL','ASSISTED','CAESAREAN','UNKNOWN'));
ALTER TABLE reproduction_birth_calf ADD COLUMN birth_condition text NOT NULL DEFAULT 'ALIVE' CHECK(birth_condition IN ('ALIVE','WEAK','UNKNOWN'));
COMMIT;
