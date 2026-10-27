-- Keep the original issuer when another authorized operator cancels a bill.
BEGIN;
SET LOCAL search_path=sdc,pg_catalog;
CREATE OR REPLACE FUNCTION sdc_operation_authorization() RETURNS trigger LANGUAGE plpgsql SET search_path=sdc,pg_catalog AS $$
DECLARE a bigint:=sdc_actor_id(); c bigint; docuser bigint; perm text;
BEGIN
 IF sdc_is_superadmin(a) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='INVOICE' THEN
  IF TG_OP='DELETE' THEN c:=OLD."Clinic_ID"; ELSE c:=NEW."Clinic_ID"; END IF; perm:='invoices.issue';
  IF TG_OP<>'DELETE' AND NEW."Invoice_Status"='issued' AND (TG_OP='INSERT' OR OLD."Invoice_Status" IS DISTINCT FROM NEW."Invoice_Status") AND NEW."Issued_By_User_ID" IS DISTINCT FROM a THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Invoice issuer must be authenticated actor'; END IF;
 ELSIF TG_TABLE_NAME='RECORDS_PAYMENT' THEN
  IF TG_OP='DELETE' THEN SELECT "Clinic_ID" INTO c FROM "INVOICE" WHERE "Invoice_ID"=OLD."Invoice_ID";
  ELSE SELECT "Clinic_ID" INTO c FROM "INVOICE" WHERE "Invoice_ID"=NEW."Invoice_ID";
   IF NEW."User_ID"<>a THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Payment recorder must be authenticated actor'; END IF;
  END IF; perm:='payments.record';
 ELSIF TG_TABLE_NAME='RECORDS_SETTLEMENT_PAYMENT' THEN
  IF TG_OP='DELETE' THEN SELECT "Clinic_ID" INTO c FROM "SETTLEMENT" WHERE "Settlement_ID"=OLD."Settlement_ID";
  ELSE SELECT "Clinic_ID" INTO c FROM "SETTLEMENT" WHERE "Settlement_ID"=NEW."Settlement_ID"; END IF; perm:='settlements.record';
 ELSIF TG_TABLE_NAME='STOCK_MOVEMENT' THEN
  IF TG_OP='DELETE' THEN SELECT "Clinic_ID" INTO c FROM "INVENTORY_ITEM" WHERE "Item_ID"=OLD."Item_ID";
  ELSE SELECT "Clinic_ID" INTO c FROM "INVENTORY_ITEM" WHERE "Item_ID"=NEW."Item_ID"; END IF; perm:='inventory.manage';
 END IF;
 IF NOT COALESCE(sdc_can(a,c,perm),false) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Actor lacks permission for this clinic'; END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='RECORDS_PAYMENT' THEN SELECT "Clinic_ID" INTO c FROM "INVOICE" WHERE "Invoice_ID"=OLD."Invoice_ID";
  ELSIF TG_TABLE_NAME='RECORDS_SETTLEMENT_PAYMENT' THEN SELECT "Clinic_ID" INTO c FROM "SETTLEMENT" WHERE "Settlement_ID"=OLD."Settlement_ID";
  ELSIF TG_TABLE_NAME='STOCK_MOVEMENT' THEN SELECT "Clinic_ID" INTO c FROM "INVENTORY_ITEM" WHERE "Item_ID"=OLD."Item_ID";
  ELSE c:=OLD."Clinic_ID"; END IF;
  IF NOT COALESCE(sdc_can(a,c,perm),false) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Actor lacks permission for source clinic'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

COMMIT;
