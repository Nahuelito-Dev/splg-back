#!/usr/bin/env bash
# Relee de la base un id vivo por entidad. Se corre antes de cada bateria,
# porque la bateria anterior pudo borrar justo el que estaba anotado.
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker exec splg-bd psql -U postgres -d splg_db -t -A -c "
SELECT * FROM (SELECT 'orderId='||order_id AS v FROM \"order\" WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') ORDER BY \"createdAt\" DESC LIMIT 1) a
UNION ALL SELECT * FROM (SELECT 'customerId='||c.customer_id FROM customer c WHERE c.\"deletedAt\" IS NULL AND EXISTS (SELECT 1 FROM \"order\" o WHERE o.customer_id=c.user_id AND o.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo')) LIMIT 1) b
UNION ALL SELECT * FROM (SELECT 'deliveryId='||d.delivery_id FROM delivery d JOIN \"user\" u ON u.user_id=d.user_id WHERE d.\"deletedAt\" IS NULL AND u.\"deletedAt\" IS NULL AND d.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') AND u.firebase_uid IS NOT NULL LIMIT 1) c
UNION ALL SELECT * FROM (SELECT 'adminId='||admin_id FROM admin LIMIT 1) d
UNION ALL SELECT * FROM (SELECT 'distributorId='||distributor_id FROM distributor WHERE slug='demo' LIMIT 1) e
UNION ALL SELECT * FROM (SELECT 'distribuidoraBaseId='||distributor_id FROM distributor WHERE slug='demo' LIMIT 1) e2
UNION ALL SELECT * FROM (SELECT 'gasCylinderId='||gas_cylinder_id FROM gas_cylinder WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) f
UNION ALL SELECT * FROM (SELECT 'cylinderId='||cylinder_id FROM cylinder WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) g
UNION ALL SELECT * FROM (SELECT 'timeSlotId='||time_slot_id FROM time_slot WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) h
UNION ALL SELECT * FROM (SELECT 'coverageZoneId='||coverage_zone_id FROM coverage_zone WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) i
UNION ALL SELECT * FROM (SELECT 'carId='||car_id FROM car WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) j
UNION ALL SELECT * FROM (SELECT 'fleetPlanId='||plan_id FROM maintenance_plan WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') AND subject='vehicle' AND name='Seguro del vehículo' LIMIT 1) j2
UNION ALL SELECT * FROM (SELECT 'fleetCarId='||car_id FROM car WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') AND \"deletedAt\" IS NULL LIMIT 1) j3
UNION ALL SELECT * FROM (SELECT 'roleId='||role_id FROM role WHERE type='qa_pruebas' LIMIT 1) k
UNION ALL SELECT * FROM (SELECT 'addressId='||address_id FROM user_address LIMIT 1) l
UNION ALL SELECT * FROM (SELECT 'ratingId='||rating_id FROM rating WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) m
UNION ALL SELECT * FROM (SELECT 'incidentId='||incident_id FROM incident WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) n
UNION ALL SELECT * FROM (SELECT 'claimId='||claim_id FROM claims WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) o
UNION ALL SELECT * FROM (SELECT 'userId='||c.user_id FROM customer c WHERE c.\"deletedAt\" IS NULL AND EXISTS (SELECT 1 FROM \"order\" o WHERE o.customer_id=c.user_id AND o.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo')) LIMIT 1) p
UNION ALL SELECT * FROM (SELECT 'customerUserId='||user_id FROM customer WHERE \"deletedAt\" IS NULL LIMIT 1) q
UNION ALL SELECT * FROM (SELECT 'deliveryUserId='||d.user_id FROM delivery d JOIN \"user\" u ON u.user_id=d.user_id WHERE d.\"deletedAt\" IS NULL AND u.\"deletedAt\" IS NULL AND d.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') AND u.firebase_uid IS NOT NULL LIMIT 1) r
UNION ALL SELECT * FROM (SELECT 'addressUserId='||ua.user_id FROM user_address ua WHERE EXISTS (SELECT 1 FROM \"order\" o WHERE o.customer_id=ua.user_id AND o.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo')) LIMIT 1) s
UNION ALL SELECT * FROM (SELECT 'email='||email FROM \"user\" WHERE email IS NOT NULL AND \"deletedAt\" IS NULL LIMIT 1) t
UNION ALL SELECT * FROM (SELECT 'phoneNumber='||phone_number FROM \"user\" WHERE phone_number IS NOT NULL AND \"deletedAt\" IS NULL LIMIT 1) u
UNION ALL SELECT * FROM (SELECT 'type='||type FROM gas_cylinder WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) v
UNION ALL SELECT * FROM (SELECT 'patent='||car_patent FROM car WHERE car_patent IS NOT NULL LIMIT 1) w
UNION ALL SELECT * FROM (SELECT 'term='||u.email FROM admin a JOIN \"user\" u ON u.user_id=a.user_id WHERE u.email IS NOT NULL LIMIT 1) x
" | grep "=" > "$SP/ids.txt"
docker exec splg-bd psql -U postgres -d splg_db -t -A -c "
SELECT * FROM (SELECT 'orderIdDelCliente='||o.order_id AS v FROM \"order\" o JOIN user_address ua ON ua.user_id=o.customer_id JOIN customer c ON c.user_id=o.customer_id WHERE c.\"deletedAt\" IS NULL AND o.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') ORDER BY o.\"createdAt\" DESC LIMIT 1) a
UNION ALL SELECT * FROM (SELECT 'customerUserId='||o.customer_id FROM \"order\" o JOIN user_address ua ON ua.user_id=o.customer_id JOIN customer c ON c.user_id=o.customer_id WHERE c.\"deletedAt\" IS NULL AND o.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') ORDER BY o.\"createdAt\" DESC LIMIT 1) b
UNION ALL SELECT * FROM (SELECT 'addressId='||ua.address_id FROM \"order\" o JOIN user_address ua ON ua.user_id=o.customer_id JOIN customer c ON c.user_id=o.customer_id WHERE c.\"deletedAt\" IS NULL AND o.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') ORDER BY o.\"createdAt\" DESC LIMIT 1) c
" | grep "=" >> "$SP/ids.txt"
wc -l < "$SP/ids.txt"

# Datos que piden los cuerpos escritos a mano y que tienen que estar libres:
# un usuario que todavia no sea admin, un envase sin asignar, y los dos roles.
docker exec splg-bd psql -U postgres -d splg_db -t -A -c "
SELECT * FROM (SELECT 'roleIdAdmin='||role_id AS v FROM role WHERE type='admin' LIMIT 1) a
UNION ALL SELECT * FROM (SELECT 'roleIdSuperAdmin='||role_id FROM role WHERE type='super_admin' LIMIT 1) b
UNION ALL SELECT * FROM (SELECT 'adminUserLibre='||u.user_id FROM \"user\" u JOIN role r ON r.role_id=u.role_id WHERE r.type='admin' AND u.\"deletedAt\" IS NULL AND NOT EXISTS (SELECT 1 FROM admin a WHERE a.user_id=u.user_id) LIMIT 1) c
UNION ALL SELECT * FROM (SELECT 'serialLibre='||serial FROM cylinder WHERE distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') LIMIT 1) d
UNION ALL SELECT * FROM (SELECT 'orderEntregado='||o.order_id FROM \"order\" o WHERE o.status='delivered' AND o.distributor_id=(SELECT distributor_id FROM distributor WHERE slug='demo') AND NOT EXISTS (SELECT 1 FROM rating r WHERE r.order_id=o.order_id) LIMIT 1) e
" | grep "=" >> "$SP/ids.txt"

# Datos de acceso que usan los cuerpos de login.
{
  echo "adminEmail=admin@splg.com"
  echo "adminPassword=Test1234"
  echo "clientePassword=Test1234"
} >> "$SP/ids.txt"
docker exec splg-bd psql -U postgres -d splg_db -t -A -c "
SELECT * FROM (SELECT 'clienteEmail='||u.email AS v FROM customer c JOIN \"user\" u ON u.user_id=c.user_id WHERE u.firebase_uid IS NOT NULL AND u.\"deletedAt\" IS NULL ORDER BY u.\"createdAt\" DESC LIMIT 1) a
UNION ALL SELECT * FROM (SELECT 'type='||type FROM gas_cylinder WHERE \"isActive\"=true LIMIT 1) b
" | grep "=" >> "$SP/ids.txt"

# El cliente de prueba, su email y su direccion tienen que salir de la MISMA
# fila: si se piden por separado, cada consulta puede caer en un usuario
# distinto y el alta de pedido falla con "No autorizado a crear pedidos para
# otro cliente". Tiene que poder entrar (firebase_uid), estar vivo el usuario
# y el cliente, y tener una direccion dentro de una zona de cobertura activa.
docker exec splg-bd psql -U postgres -d splg_db -t -A -c "
WITH elegido AS (
  SELECT u.user_id, u.email, ua.address_id
  FROM customer c
  JOIN \"user\" u ON u.user_id = c.user_id
  JOIN user_address ua ON ua.user_id = u.user_id
  JOIN coverage_zone z
    ON ST_Contains(z.area, ua.location)
  WHERE u.firebase_uid IS NOT NULL
    AND u.\"deletedAt\" IS NULL
    AND c.\"deletedAt\" IS NULL
    AND z.\"isActive\" = true
    AND u.email LIKE '%@splg-test.com'
  ORDER BY u.\"createdAt\" DESC
  LIMIT 1
)
SELECT 'customerUserId='||user_id FROM elegido
UNION ALL SELECT 'clienteEmail='||email FROM elegido
UNION ALL SELECT 'addressId='||address_id FROM elegido
" | grep "=" >> "$SP/ids.txt"

# El chofer de prueba tiene que poder entrar de verdad: con cuenta en Firebase,
# vivo, no bloqueado y con fila de delivery en la distribuidora real. Desde que
# el login rechaza cuentas dadas de baja, apuntar a una borrada da 401.
# Habilitado y validado, porque el caso correcto de la disponibilidad
# (PATCH /delivery/user/{userId}/availability con available=true) ahora exige
# los dos: un chofer sin validar da 403 y ahí el "camino feliz" no lo es.
docker exec splg-bd psql -U postgres -d splg_db -t -A -c "
SELECT 'choferEmail='||u.email
FROM delivery d
JOIN \"user\" u ON u.user_id = d.user_id
WHERE u.firebase_uid IS NOT NULL
  AND u.\"deletedAt\" IS NULL
  AND d.\"deletedAt\" IS NULL
  AND u.blocked = false
  AND d.\"isEnabled\" = true
  AND d.validated = true
  AND d.distributor_id = (SELECT distributor_id FROM distributor WHERE slug='demo')
  AND u.email LIKE '%@splg-test.com'
ORDER BY u.\"createdAt\" DESC
LIMIT 1
" | grep "=" >> "$SP/ids.txt"
