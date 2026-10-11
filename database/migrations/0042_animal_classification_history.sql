BEGIN;

-- Consulta siempre relaciones vigentes: borrar o trasladar una cría no rompe el historial.
CREATE OR REPLACE FUNCTION classify_animal(p_animal_id uuid,p_date date) RETURNS varchar(20)
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
    WHERE birth.occurred_on<=p_date
      AND (subject.sex='FEMALE' AND birth.mother_id=p_animal_id
        OR subject.sex='MALE' AND preg.father_id=p_animal_id)
  ) INTO offspring;
  IF subject.sex='FEMALE' THEN
    IF offspring THEN RETURN 'VACA'; END IF;
    IF subject.birth_date IS NOT NULL
      AND (subject.birth_date+make_interval(months=>female_months))::date>p_date THEN
      RETURN 'TERNERA';
    END IF;
    RETURN 'VACONA';
  END IF;
  IF subject.sex='MALE' THEN
    IF offspring OR EXISTS(
      SELECT 1 FROM reproduction_pregnancy preg
      WHERE preg.father_id=p_animal_id AND preg.status IN ('CONFIRMED','BORN','LOST')
        AND preg.confirmed_on<=p_date
    ) THEN RETURN 'TORO'; END IF;
    IF subject.birth_date IS NOT NULL
      AND (subject.birth_date+make_interval(months=>male_months))::date>p_date THEN
      RETURN 'TERNERO';
    END IF;
    RETURN 'TORETE';
  END IF;
  RETURN 'SIN_CLASIFICAR';
END;
$$;


COMMIT;
