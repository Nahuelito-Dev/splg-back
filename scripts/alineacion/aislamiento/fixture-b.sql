-- Datos de la distribuidora B para el barrido de aislamiento. Ids fijos bbbb...
\set B '''5bb47681-f5a0-4cd9-ada2-5f08e5e0e41c'''
\set DRV '''a29dc060-6efc-4fe3-9f21-8bef5643eb26'''
\set DLV '''de19bd70-c58d-4823-a409-c077cd7be352'''
\set CLI '''6addc762-49c9-4262-8e82-aca374604acf'''
BEGIN;
INSERT INTO user_address (address_id, user_id, street, city, location, "isDefault", "createdAt", "updatedAt")
  VALUES ('bbbb0000-0000-4000-8000-00000000000f',:CLI,'Calle B 123','Posadas',ST_SetSRID(ST_MakePoint(-55.90,-27.37),4326),false,now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO time_slot VALUES ('bbbb0000-0000-4000-8000-000000000001',:B,'Franja B','08:00','12:00',10,true,now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO coverage_zone SELECT 'bbbb0000-0000-4000-8000-000000000002',:B,'Zona B',area,0,true,now(),now() FROM coverage_zone LIMIT 1 ON CONFLICT DO NOTHING;
INSERT INTO gas_cylinder VALUES ('bbbb0000-0000-4000-8000-000000000003',:B,'B-10kg',10,9999,50,'garrafa B',true,now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO car VALUES ('bbbb0000-0000-4000-8000-000000000004',:B,:DRV,'camioneta',20,'BBB999','Ford','Ranger',2020,'rojo',now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO "order" (order_id,distributor_id,customer_id,time_slot_id,scheduled_date,deposit_amount,deposit_paid,delivery_id,address_id,status,"paymentMethod","paymentType","paymentStatus","totalAmount","createdAt","updatedAt","deliveredAt","deliveryCode")
  SELECT 'bbbb0000-0000-4000-8000-000000000005',:B,:CLI,'bbbb0000-0000-4000-8000-000000000001',current_date,0,false,:DLV,address_id,'delivered','cash','cash','paid',9999,now(),now(),now(),'1234' FROM user_address WHERE address_id='bbbb0000-0000-4000-8000-00000000000f' ON CONFLICT DO NOTHING;
INSERT INTO "order" (order_id,distributor_id,customer_id,time_slot_id,scheduled_date,deposit_amount,deposit_paid,delivery_id,address_id,status,"paymentMethod","paymentType","paymentStatus","totalAmount","createdAt","updatedAt","deliveryCode")
  SELECT 'bbbb0000-0000-4000-8000-000000000006',:B,:CLI,'bbbb0000-0000-4000-8000-000000000001',current_date,0,false,null,address_id,'pending','cash','cash','pending',9999,now(),now(),'4321' FROM user_address WHERE address_id='bbbb0000-0000-4000-8000-00000000000f' ON CONFLICT DO NOTHING;
INSERT INTO order_item VALUES ('bbbb0000-0000-4000-8000-000000000007','bbbb0000-0000-4000-8000-000000000005','bbbb0000-0000-4000-8000-000000000003',1,9999,9999) ON CONFLICT DO NOTHING;
INSERT INTO order_item VALUES ('bbbb0000-0000-4000-8000-000000000008','bbbb0000-0000-4000-8000-000000000006','bbbb0000-0000-4000-8000-000000000003',1,9999,9999) ON CONFLICT DO NOTHING;
INSERT INTO cylinder VALUES ('bbbb0000-0000-4000-8000-000000000009',:B,'SER-B-0001','bbbb0000-0000-4000-8000-000000000003','in_depot',null,null,0,now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO cylinder_movement VALUES ('bbbb0000-0000-4000-8000-00000000000a','bbbb0000-0000-4000-8000-000000000009',:B,null,'in_depot',null,null,'alta',now()) ON CONFLICT DO NOTHING;
INSERT INTO claims VALUES ('bbbb0000-0000-4000-8000-00000000000b',:B,'bbbb0000-0000-4000-8000-000000000005',:CLI,'otro','reclamo B',null,'pending',null,now()) ON CONFLICT DO NOTHING;
INSERT INTO incident VALUES ('bbbb0000-0000-4000-8000-00000000000c','bbbb0000-0000-4000-8000-000000000005',:B,:DRV,'other','incidente B',null,'open',null,now(),null) ON CONFLICT DO NOTHING;
INSERT INTO rating VALUES ('bbbb0000-0000-4000-8000-00000000000d','bbbb0000-0000-4000-8000-000000000005',:B,:CLI,:DRV,'customer',5,'bien',now()) ON CONFLICT DO NOTHING;
INSERT INTO payment (payment_id,order_id,distributor_id,gateway,integration,amount,currency,status,is_deposit,"createdAt","updatedAt") VALUES ('bbbb0000-0000-4000-8000-00000000000e','bbbb0000-0000-4000-8000-000000000005',:B,'cash','cash',9999,'ARS','approved',false,now(),now()) ON CONFLICT DO NOTHING;
COMMIT;
