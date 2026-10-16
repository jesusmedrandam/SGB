BEGIN;
CREATE TABLE animal_data_review (
 property_id uuid NOT NULL REFERENCES property(id),
 identity_id uuid NOT NULL,
 field_code varchar(30) NOT NULL CHECK(field_code IN ('photo','name','earTag','birthDate','entryDate','owners','location')),
 dismissed boolean NOT NULL,
 reviewed_by uuid NOT NULL REFERENCES app_user(id),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(property_id,identity_id,field_code)
);
COMMIT;
