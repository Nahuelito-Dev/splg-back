# -*- coding: utf-8 -*-
"""Cuerpos escritos a mano para los endpoints que el generador no acierta solo.

Los marcadores <<algo>> los reemplaza cada consumidor: la bateria pone el id
real de la base, y el generador de Postman pone {{algo}}.

Por cada entrada hay dos cosas: `ok` (lo que tiene que funcionar) y `malo`
(lo que tiene que dar 400), para poder probar el exito y el fallo.
"""
UNICO = "<<unico>>"
TEL = "<<sufijo>>"   # seis digitos: E.164 no admite mas de 15 en total   # sufijo distinto en cada corrida, para lo que debe ser unico

CUERPOS = {
    "POST /api/orders": {
        "ok": {
            "customerId": "<<customerUserId>>",
            "addressId": "<<addressId>>",
            "items": [{"gasCylinderId": "<<gasCylinderId>>", "quantity": 1, "unitPrice": 100}],
            "paymentMethod": "cash",
            "notes": "Pedido de prueba automatizada",
        },
        "malo": {"customerId": "no-es-uuid", "items": [], "paymentMethod": "efectivo"},
    },
    "POST /api/user-address": {
        "ok": {
            "user_id": "<<customerUserId>>",
            "street": "Av. Siempreviva 742",
            "city": "Posadas",
            "postalCode": "3300",
            "latitude": "-27.3671",
            "longitude": "-55.8961",
        },
        "malo": {"user_id": "no-es-uuid", "street": 12345},
    },
    "POST /api/incidents": {
        "ok": {
            "orderId": "<<orderId>>",
            "type": "damaged",
            "description": "Envase con la valvula danada al momento de la entrega",
        },
        "malo": {"orderId": "no-es-uuid", "type": "inexistente", "description": ""},
    },
    "PATCH /api/incidents/{id}/resolve": {
        "ok": {"resolutionNote": "Se repuso el envase y se cerro la incidencia"},
        "malo": {"resolutionNote": 123},
    },
    "POST /api/distributor": {
        "ok": {
            "name": "Distribuidora de Prueba " + UNICO,
            "slug": "prueba-" + UNICO,
            "legal_name": "Distribuidora de Prueba S.R.L.",
            "tax_id": "30-99999999-9",
            "email": "prueba" + UNICO + "@splg-test.com",
            "phone": "+543764999999",
        },
        "malo": {"name": "x", "slug": "Slug Invalido Con Mayusculas"},
    },
    "POST /api/gascylinder": {
        "ok": {"type": "Garrafa prueba " + UNICO, "weight": 10, "price": 8500, "stock": 25,
               "description": "Producto creado por la bateria"},
        "malo": {"type": "", "weight": "diez", "price": -1},
    },
    "PATCH /api/gascylinder/{id}/stock": {
        "ok": {"quantity": 5},
        # Sin DTO, esto hoy NO da 400 sino 500: es el hallazgo H-24.
        "malo": {"quantity": "no-es-un-numero"},
    },
    "POST /api/coverage-zones": {
        "ok": {
            "name": "Zona de prueba " + UNICO,
            "polygon": [[-27.36, -55.90], [-27.36, -55.88], [-27.38, -55.88], [-27.36, -55.90]],
            "surcharge": 150,
            "isActive": True,
        },
        "malo": {"name": "", "polygon": "no-es-un-poligono"},
    },
    "POST /api/car": {
        "ok": {"user_id": "<<deliveryUserId>>", "type_car": "Camioneta",
               "car_capacity": 20, "car_patent": "QA" + UNICO, "car_brand": "Ford",
               "car_model": "Ranger", "car_year": 2020, "car_color": "Blanco"},
        "malo": {"user_id": "no-es-uuid", "car_year": "dos mil veinte"},
    },
    "POST /api/time-slot": {
        "ok": {"name": "Franja prueba " + UNICO, "startTime": "14:00", "endTime": "18:00", "capacity": 30},
        "malo": {"name": "", "startTime": "25:99", "endTime": 5},
    },
    "POST /api/cylinders": {
        "ok": {"serial": "QA-" + UNICO, "gasCylinderId": "<<gasCylinderId>>", "deposit": 5000},
        "malo": {"serial": "", "gasCylinderId": "no-es-uuid"},
    },
    "POST /api/auth/registro": {
        "ok": {"email": "qa.reg." + UNICO + "@splg-test.com", "password": "Test1234",
               "full_name": "QA Cliente Registro", "phone_number": "+549382" + TEL},
        "malo": {"email": "no-es-un-email", "password": "", "full_name": "x"},
    },
    # Ruta anterior de /auth/registro, la usan las versiones publicadas de la app.
    "POST /api/users/customer-registration": {
        "ok": {"email": "qa.cli." + UNICO + "@splg-test.com", "password": "Test1234",
               "full_name": "QA Cliente Automatico", "phone_number": "+549381" + TEL},
        "malo": {"email": "no-es-un-email", "password": "", "full_name": "x"},
    },
    "POST /api/users/check-exists": {
        "ok": {"email": "<<email>>"},
        "malo": {"email": 12345},
    },
    "POST /api/auth/login": {
        "ok": {"email": "<<clienteEmail>>", "password": "<<clientePassword>>"},
        "malo": {"email": "no-es-un-email", "password": ""},
    },
    "POST /api/auth/login/dashboard": {
        "ok": {"email": "<<adminEmail>>", "password": "<<adminPassword>>"},
        "malo": {"email": "no-es-un-email", "password": ""},
    },
    "POST /api/claims": {
        "ok": {"orderId": "<<orderIdDelCliente>>", "customerId": "<<customerUserId>>",
               "reason": "Carga incompleta",
               "description": "El envase llego con menos carga de la esperada"},
        "malo": {"orderId": "no-es-uuid", "description": ""},
    },
    "POST /api/ratings": {
        # Solo se puede calificar un pedido ya entregado.
        "ok": {"orderId": "<<orderEntregado>>", "stars": 5,
               "comment": "Entrega puntual, todo bien"},
        "malo": {"orderId": "no-es-uuid", "stars": 99},
    },

    # --- segunda tanda: los 22 que quedaban con cuerpo generado ---
    "POST /api/admin": {
        "ok": {"user_id": "<<adminUserLibre>>",
               "distributor_id": "<<distributorId>>"},
        "malo": {"user_id": "no-es-uuid", "role_id": "tampoco"},
    },
    "PATCH /api/car/{id}": {
        "ok": {"car_brand": "Chevrolet", "car_model": "S10", "car_color": "Gris"},
        "malo": {"car_year": "dos mil veinte", "car_capacity": "mucha"},
    },
    "PATCH /api/claims/{id}/resolve": {
        "ok": {"resolution": "Se repuso el producto y se cerro el reclamo",
               "status": "resolved"},
        "malo": {"resolution": "", "status": "estado_inexistente"},
    },
    "PATCH /api/customers/{id}": {
        # UpdateCustomerDto es PartialType(CreateCustomerDto): el campo es lat_lang.
        "ok": {"lat_lang": "-27.3671,-55.8961"},
        "malo": {"user_id": "no-es-uuid", "campo_inventado": "x"},
    },
    "POST /api/cylinders/assign": {
        "ok": {"orderId": "<<orderIdDelCliente>>", "serials": ["<<serialLibre>>"]},
        "malo": {"orderId": "no-es-uuid", "serials": "no-es-una-lista"},
    },
    "PATCH /api/cylinders/{id}/transition": {
        "ok": {"toState": "filled", "note": "Envase cargado en planta"},
        "malo": {"toState": "estado_inexistente"},
    },
    "PATCH /api/delivery/{id}": {
        # Sólo validated e isActive: la calificación sale de las
        # calificaciones y los datos de la persona van por /users.
        "ok": {"validated": True, "isActive": True},
        "malo": {"validated": "si", "calification": 5},
    },
    "PATCH /api/distributor/{id}": {
        "ok": {"phone": "+543764111222"},
        "malo": {"slug": "Slug Invalido Con Mayusculas"},
    },
    "POST /api/email/change-email": {
        # Sin un idToken real de Firebase esto tiene que dar 400: es lo correcto.
        "ok": {"currentEmail": "<<email>>", "newEmail": "nuevo." + UNICO + "@splg-test.com",
               "idToken": "token-de-prueba"},
        "malo": {"currentEmail": "no-es-un-email", "newEmail": "tampoco", "idToken": ""},
    },
    "POST /api/email/password-reset": {
        "ok": {"email": "<<email>>"},
        "malo": {"email": "no-es-un-email"},
    },
    "POST /api/email/test": {
        "ok": {"email": "<<email>>"},
        "malo": {"email": "no-es-un-email"},
    },
    "PATCH /api/gascylinder/{id}": {
        "ok": {"price": 9900, "description": "Precio actualizado por la bateria"},
        "malo": {"weight": "diez kilos", "price": "carisimo"},
    },
    "PATCH /api/orders/{id}/cancel": {
        "ok": {"reason": "El cliente ya no necesita el pedido"},
        "malo": {"reason": "x" * 600},
    },
    "POST /api/orders/{id}/confirm-delivery": {
        # El codigo real sale de GET /orders/{id}/delivery-code.
        "ok": {"code": "<<codigoEntrega>>"},
        "malo": {"code": ""},
    },
    "PATCH /api/orders/{id}/location": {
        "ok": {"lat": -27.3671, "lng": -55.8961},
        "malo": {"lat": 999, "lng": "muy al oeste"},
    },
    "PATCH /api/orders/{id}/status": {
        "ok": {"status": "accepted"},
        "malo": {"status": "estado_inexistente"},
    },
    "POST /api/role": {
        "ok": {"type": "rol_prueba_" + UNICO},
        "malo": {"type": 12345},
    },
    "PATCH /api/role/{id}": {
        "ok": {"type": "rol_renombrado_" + UNICO},
        "malo": {"type": 12345},
    },
    "PATCH /api/user-address/{id}": {
        "ok": {"street": "Av. Mitre 4321", "city": "Posadas"},
        "malo": {"latitude": 123, "longitude": 456},
    },
    # Alta desde el panel: el rol decide el perfil. Un chofer necesita
    # distribuidora; la coleccion corre como super admin. Va la distribuidora
    # base y no {{distributorId}}, que la carpeta Distributor reapunta a la que
    # crea y después borra.
    "POST /api/users": {
        "ok": {"email": "qa.user." + UNICO + "@splg-test.com", "password": "Test1234",
               "full_name": "QA Chofer Alta", "phone_number": "+549388" + TEL,
               "rol": "delivery", "distributorId": "<<distribuidoraBaseId>>"},
        "malo": {"email": "no-es-un-email", "full_name": "", "rol": "qa_pruebas"},
    },
    "PATCH /api/users/{id}": {
        "ok": {"full_name": "Nombre Actualizado " + UNICO},
        "malo": {"email": "no-es-un-email"},
    },

    # --- los 11 sin DTO (ver H-31) ---
    # El OpenAPI no declara cuerpo para ninguno de estos, asi que el generador
    # no puede inventarlo: hay que escribirlo a mano leyendo el controlador.
    "PATCH /api/users/{id}/block": {
        "ok": {"block": False},
        "malo": {"block": "quiza"},
    },
    "PATCH /api/customers/{id}/location": {
        "ok": {"latLng": "-27.3671,-55.8961"},
        "malo": {"latLng": 12345},
    },
    "PATCH /api/delivery/{id}/location": {
        "ok": {"latLng": "-27.3671,-55.8961", "actualLocation": "Av. Mitre 1234"},
        "malo": {"latLng": 12345},
    },
    "PATCH /api/delivery/{id}/balance": {
        "ok": {"amount": 1500},
        "malo": {"amount": "mil quinientos"},
    },
    "PATCH /api/delivery/{id}/status": {
        "ok": {"isActive": True},
        "malo": {"isActive": "si"},
    },
    "PATCH /api/delivery/user/{userId}/availability": {
        "ok": {"available": True},
        "malo": {"available": "mas o menos"},
    },
    "POST /api/notifications/token": {
        "ok": {"userId": "<<customerUserId>>", "token": "token-fcm-de-prueba-" + UNICO,
               "platform": "android"},
        "malo": {"userId": "no-es-uuid", "token": "", "platform": 123},
    },
    "POST /api/notifications/send-test": {
        "ok": {"token": "token-fcm-de-prueba", "title": "Prueba",
               "body": "Notificacion de prueba de la bateria"},
        "malo": {"token": "", "title": 123},
    },
    "POST /api/notifications/order-confirmation": {
        "ok": {"customerId": "<<customerUserId>>", "orderId": "<<orderIdDelCliente>>"},
        "malo": {"customerId": "no-es-uuid", "orderId": "tampoco"},
    },
}
