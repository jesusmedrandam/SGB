BEGIN;

ALTER TABLE app_user ADD COLUMN profile_photo_data text
  CHECK (profile_photo_data IS NULL OR
    (length(profile_photo_data) <= 200000 AND profile_photo_data LIKE 'data:image/webp;base64,%'));

COMMIT;
