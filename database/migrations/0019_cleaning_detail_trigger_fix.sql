BEGIN;

CREATE OR REPLACE FUNCTION protect_pasture_cleaning_detail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleaning_id uuid; current_status varchar(16);
BEGIN
 IF TG_OP='DELETE' THEN cleaning_id:=OLD.cleaning_id; ELSE cleaning_id:=NEW.cleaning_id; END IF;
 SELECT status INTO current_status FROM pasture_cleaning WHERE id=cleaning_id;
 IF current_status<>'BORRADOR' THEN
   RAISE EXCEPTION 'Los productos y operadores de una limpieza finalizada son inmutables.' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='pasture_cleaning_product' THEN
   IF TG_OP<>'DELETE' THEN
     IF NOT EXISTS(SELECT 1 FROM pasture_cleaning c JOIN pasture_agrochemical p
       ON p.id=NEW.product_id AND p.account_id=c.account_id WHERE c.id=cleaning_id) THEN
       RAISE EXCEPTION 'El producto no pertenece a la cuenta de la limpieza.' USING ERRCODE='23514';
     END IF;
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

COMMIT;
