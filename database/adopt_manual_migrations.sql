-- Uso único para una base donde 0001–0006 se ejecutaron manualmente.
-- Valida objetos representativos antes de registrar sus checksums.
-- Este archivo no coincide con el patrón de migraciones y nunca se ejecuta
-- automáticamente mediante npm run migrate.

BEGIN;

DO $$
DECLARE
  missing_objects text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.app_user') IS NULL
    OR to_regclass('public.audit_event') IS NULL
    OR to_regclass('public.effective_property_module') IS NULL THEN
    missing_objects := array_append(missing_objects, '0001_platform_foundation.sql');
  END IF;

  IF to_regclass('public.species_catalog') IS NULL
    OR to_regclass('public.allowed_context_unit') IS NULL
    OR to_regclass('public.effective_property_species') IS NULL THEN
    missing_objects := array_append(missing_objects, '0002_catalog_governance.sql');
  END IF;

  IF to_regclass('public.role_template') IS NULL
    OR to_regclass('public.email_verification_token') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_session'
        AND column_name = 'access_token_hash'
    ) THEN
    missing_objects := array_append(missing_objects, '0003_access_and_context.sql');
  END IF;

  IF to_regclass('public.quota_catalog') IS NULL
    OR to_regclass('public.animal_status_transition') IS NULL
    OR to_regclass('public.effective_account_quota') IS NULL THEN
    missing_objects := array_append(missing_objects, '0004_quotas_and_animal_lifecycle.sql');
  END IF;

  IF to_regclass('public.storage_object') IS NULL
    OR to_regclass('public.storage_deletion_job') IS NULL
    OR to_regclass('public.entity_tombstone') IS NULL
    OR to_regprocedure('public.queue_storage_deletion()') IS NULL THEN
    missing_objects := array_append(missing_objects, '0005_safe_retention_and_media.sql');
  END IF;

  IF to_regclass('public.animal') IS NULL
    OR to_regclass('public.livestock_group') IS NULL
    OR to_regclass('public.physical_location') IS NULL
    OR to_regclass('public.physical_location_occupancy') IS NULL
    OR to_regprocedure(
      'public.move_animal_to_trash(uuid,uuid,uuid,text,uuid,bigint)'
    ) IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = 'public.animal'::regclass
        AND tgname = 'animal_no_direct_delete'
        AND NOT tgisinternal
    ) THEN
    missing_objects := array_append(missing_objects, '0006_livestock_core.sql');
  END IF;

  IF cardinality(missing_objects) > 0 THEN
    RAISE EXCEPTION
      'No se registró la línea base. Faltan objetos de: %',
      array_to_string(missing_objects, ', ')
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS schema_migration (
  filename text PRIMARY KEY,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  checksum_conflicts text[];
BEGIN
  SELECT array_agg(expected.filename ORDER BY expected.filename)
    INTO checksum_conflicts
  FROM (
    VALUES
      ('0001_platform_foundation.sql', 'cf8731ad4ffa1a47146d832557a841af53586ff63dd985aa684811a60a668d0e'),
      ('0002_catalog_governance.sql', '1ce64dfaf23ca76104d7437acca09d443d67c3ebfc7b4cea97bb429101310227'),
      ('0003_access_and_context.sql', '1423b030c9cb00b1317f0b2da3af887d302c6d303bb18cbd86364269d90b7470'),
      ('0004_quotas_and_animal_lifecycle.sql', 'b14ce6b5ab2771586f43a55c8f93bf3838f8e12412cf81e3ee1fdd9e7301cfdd'),
      ('0005_safe_retention_and_media.sql', '8c3f0a1489fbd96e4c5f622b3553c0df05ba54a5adddc5d1f8acea7cdfade033'),
      ('0006_livestock_core.sql', '7414e18eb97b9bdee35d098094929a251226acb9e33a09791e125144fa8a7e52')
  ) AS expected(filename, checksum)
  JOIN schema_migration applied USING (filename)
  WHERE btrim(applied.checksum) <> expected.checksum;

  IF cardinality(checksum_conflicts) > 0 THEN
    RAISE EXCEPTION
      'No se registró la línea base. Hay checksums diferentes en: %',
      array_to_string(checksum_conflicts, ', ')
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

INSERT INTO schema_migration(filename, checksum) VALUES
  ('0001_platform_foundation.sql', 'cf8731ad4ffa1a47146d832557a841af53586ff63dd985aa684811a60a668d0e'),
  ('0002_catalog_governance.sql', '1ce64dfaf23ca76104d7437acca09d443d67c3ebfc7b4cea97bb429101310227'),
  ('0003_access_and_context.sql', '1423b030c9cb00b1317f0b2da3af887d302c6d303bb18cbd86364269d90b7470'),
  ('0004_quotas_and_animal_lifecycle.sql', 'b14ce6b5ab2771586f43a55c8f93bf3838f8e12412cf81e3ee1fdd9e7301cfdd'),
  ('0005_safe_retention_and_media.sql', '8c3f0a1489fbd96e4c5f622b3553c0df05ba54a5adddc5d1f8acea7cdfade033'),
  ('0006_livestock_core.sql', '7414e18eb97b9bdee35d098094929a251226acb9e33a09791e125144fa8a7e52')
ON CONFLICT (filename) DO NOTHING;

DO $$
DECLARE
  registered_count integer;
BEGIN
  SELECT count(*) INTO registered_count
  FROM schema_migration
  WHERE filename IN (
    '0001_platform_foundation.sql',
    '0002_catalog_governance.sql',
    '0003_access_and_context.sql',
    '0004_quotas_and_animal_lifecycle.sql',
    '0005_safe_retention_and_media.sql',
    '0006_livestock_core.sql'
  );

  IF registered_count <> 6 THEN
    RAISE EXCEPTION 'La línea base quedó incompleta: % de 6 migraciones.', registered_count
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

COMMIT;

SELECT filename, btrim(checksum) AS checksum, applied_at
FROM schema_migration
ORDER BY filename;
