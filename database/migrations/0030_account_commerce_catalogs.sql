BEGIN;

-- The catalog service already lists account items from every property. Keep the
-- originating property for auditing, while associating sales to catalog IDs.
ALTER TABLE commerce_record ADD COLUMN buyer_catalog_item_id uuid REFERENCES governed_catalog_item(id);
ALTER TABLE commerce_line ADD COLUMN product_catalog_item_id uuid REFERENCES governed_catalog_item(id);
CREATE INDEX commerce_record_buyer_catalog_idx ON commerce_record(buyer_catalog_item_id)
  WHERE buyer_catalog_item_id IS NOT NULL;
CREATE INDEX commerce_line_product_catalog_idx ON commerce_line(product_catalog_item_id)
  WHERE product_catalog_item_id IS NOT NULL;

-- Make existing buyers and products available in the account-wide lists.
INSERT INTO governed_catalog_item(catalog_code,account_id,property_id,name,created_by)
SELECT DISTINCT ON (r.account_id,lower(btrim(r.counterparty_name)))
  'BUYERS',r.account_id,r.property_id,btrim(r.counterparty_name),r.created_by
FROM commerce_record r
WHERE r.kind='SALE' AND length(btrim(r.counterparty_name)) BETWEEN 2 AND 160
  AND NOT EXISTS (SELECT 1 FROM governed_catalog_item ci WHERE ci.catalog_code='BUYERS'
    AND ci.account_id=r.account_id AND lower(ci.name)=lower(btrim(r.counterparty_name))
    AND ci.deleted_at IS NULL)
ORDER BY r.account_id,lower(btrim(r.counterparty_name)),r.created_at,r.id;

INSERT INTO governed_catalog_item(catalog_code,account_id,property_id,name,created_by)
SELECT DISTINCT ON (r.account_id,lower(btrim(l.product_name)))
  'SALE_PRODUCTS',r.account_id,r.property_id,btrim(l.product_name),r.created_by
FROM commerce_line l JOIN commerce_record r ON r.id=l.record_id
WHERE r.kind='SALE' AND l.product_name IS NOT NULL
  AND length(btrim(l.product_name)) BETWEEN 2 AND 160
  AND NOT EXISTS (SELECT 1 FROM governed_catalog_item ci WHERE ci.catalog_code='SALE_PRODUCTS'
    AND ci.account_id=r.account_id AND lower(ci.name)=lower(btrim(l.product_name))
    AND ci.deleted_at IS NULL)
ORDER BY r.account_id,lower(btrim(l.product_name)),r.created_at,r.id;

COMMIT;
