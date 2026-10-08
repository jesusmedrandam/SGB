BEGIN;
ALTER TABLE governed_catalog_item ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE pasture_agrochemical ADD COLUMN version integer NOT NULL DEFAULT 1;

CREATE FUNCTION bump_account_catalog_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END;
$$;
CREATE TRIGGER governed_catalog_item_version BEFORE UPDATE ON governed_catalog_item
FOR EACH ROW EXECUTE FUNCTION bump_account_catalog_version();
CREATE TRIGGER pasture_agrochemical_version BEFORE UPDATE ON pasture_agrochemical
FOR EACH ROW EXECUTE FUNCTION bump_account_catalog_version();

ALTER TABLE pasture_cleaning_product ADD COLUMN product_name varchar(160);
-- Backfill only the new historical name while ALTER TABLE holds the transaction lock.
ALTER TABLE pasture_cleaning_product DISABLE TRIGGER pasture_cleaning_product_protect;
UPDATE pasture_cleaning_product d SET product_name=p.name FROM pasture_agrochemical p WHERE p.id=d.product_id;
ALTER TABLE pasture_cleaning_product ENABLE TRIGGER pasture_cleaning_product_protect;
ALTER TABLE pasture_cleaning_product ALTER COLUMN product_name SET NOT NULL;
CREATE FUNCTION snapshot_cleaning_product_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN SELECT name INTO NEW.product_name FROM pasture_agrochemical WHERE id=NEW.product_id; RETURN NEW; END;
$$;
CREATE TRIGGER cleaning_product_name BEFORE INSERT OR UPDATE OF product_id ON pasture_cleaning_product
FOR EACH ROW EXECUTE FUNCTION snapshot_cleaning_product_name();
COMMIT;
