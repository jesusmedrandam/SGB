BEGIN;

-- Los seis códigos son globales; cada cuenta puede ajustar sus nombres y edades.
CREATE TABLE animal_classification_catalog (
  code varchar(20) PRIMARY KEY,
  name varchar(80) NOT NULL,
  sex animal_sex NOT NULL
);
INSERT INTO animal_classification_catalog(code,name,sex) VALUES
  ('VACA','Vaca','FEMALE'),('VACONA','Vacona','FEMALE'),
  ('TERNERA','Ternera','FEMALE'),('TORO','Toro','MALE'),
  ('TORETE','Torete','MALE'),('TERNERO','Ternero','MALE');

CREATE TABLE account_animal_classification_policy (
  account_id uuid PRIMARY KEY REFERENCES administrative_account(id),
  female_adult_months integer NOT NULL DEFAULT 12 CHECK(female_adult_months BETWEEN 1 AND 120),
  male_adult_months integer NOT NULL DEFAULT 12 CHECK(male_adult_months BETWEEN 1 AND 120),
  updated_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_animal_classification_name (
  account_id uuid NOT NULL REFERENCES administrative_account(id),
  code varchar(20) NOT NULL REFERENCES animal_classification_catalog(code),
  name varchar(80) NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 80),
  PRIMARY KEY(account_id,code)
);

-- Consulta siempre relaciones vigentes: borrar o trasladar una cría no rompe el historial.
CREATE FUNCTION classify_animal(p_animal_id uuid,p_date date) RETURNS varchar(20)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  subject animal%ROWTYPE;
  female_months integer;
  male_months integer;
  offspring boolean;
BEGIN
  SELECT * INTO subject FROM animal WHERE id=p_animal_id AND record_status='CURRENT';
  IF NOT FOUND THEN RETURN 'SIN_CLASIFICAR'; END IF;
  SELECT COALESCE(policy.female_adult_months,12),COALESCE(policy.male_adult_months,12)
    INTO female_months,male_months FROM property prop
    LEFT JOIN account_animal_classification_policy policy ON policy.account_id=prop.account_id
    WHERE prop.id=subject.property_id;
  SELECT EXISTS(
    SELECT 1 FROM animal_parentage ap JOIN animal child ON child.id=ap.child_animal_id
    WHERE ap.parent_animal_id=p_animal_id AND ap.removed_at IS NULL
      AND child.record_status<>'PURGED' AND (child.birth_date IS NULL OR child.birth_date<=p_date)
  ) OR EXISTS(
    SELECT 1 FROM reproduction_birth birth
    LEFT JOIN reproduction_pregnancy preg ON preg.id=birth.pregnancy_id
    WHERE birth.live_count>0 AND birth.occurred_on<=p_date
      AND (subject.sex='FEMALE' AND birth.mother_id=p_animal_id
        OR subject.sex='MALE' AND preg.father_id=p_animal_id)
  ) INTO offspring;
  IF subject.sex='FEMALE' THEN
    IF offspring THEN RETURN 'VACA'; END IF;
    IF subject.birth_date IS NOT NULL
      AND subject.birth_date>p_date-make_interval(months=>female_months) THEN
      RETURN 'TERNERA';
    END IF;
    RETURN 'VACONA';
  END IF;
  IF subject.sex='MALE' THEN
    IF offspring OR EXISTS(
      SELECT 1 FROM reproduction_pregnancy preg
      WHERE preg.father_id=p_animal_id AND preg.status IN ('CONFIRMED','BORN')
        AND preg.confirmed_on<=p_date
    ) THEN RETURN 'TORO'; END IF;
    IF subject.birth_date IS NOT NULL
      AND subject.birth_date>p_date-make_interval(months=>male_months) THEN
      RETURN 'TERNERO';
    END IF;
    RETURN 'TORETE';
  END IF;
  RETURN 'SIN_CLASIFICAR';
END;
$$;

COMMIT;
