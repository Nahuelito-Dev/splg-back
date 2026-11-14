/**
 * Mensajes en castellano para las restricciones que la base impone además del
 * back (CHECK, índices únicos, exclusiones y claves foráneas). Cada regla ya la
 * valida el back con un 400/409 legible antes de llegar a la base; esto cubre
 * lo que se escapa (dos operaciones al mismo tiempo, un camino sin validar) para
 * que el cliente reciba el motivo y no un 500.
 *
 * La clave es el nombre de la restricción o del índice, que Postgres informa en
 * `constraint` del error.
 */
export const MENSAJES_DE_RESTRICCIONES: Readonly<Record<string, string>> = {
  // Pedido
  CHK_order_intentos_codigo:
    'Los intentos del código de entrega no pueden ser negativos',
  CHK_order_montos: 'Los montos del pedido no pueden ser negativos',
  CHK_order_total_formula:
    'El total del pedido no coincide con la suma de ítems, recargos y envío',
  CHK_order_pago_coherente:
    'El tipo de pago no corresponde al medio de pago elegido',
  CHK_order_aceptado_fecha:
    'Un pedido aceptado, en camino o entregado tiene que tener la fecha de aceptación',
  CHK_order_en_camino_fecha:
    'Un pedido en camino o entregado tiene que tener la fecha de salida',
  CHK_order_entregado_fecha:
    'La fecha de entrega sólo corresponde a un pedido entregado (y es obligatoria en ese caso)',
  CHK_order_chofer_asignado:
    'Un pedido aceptado, en camino o entregado tiene que tener chofer asignado',
  CHK_order_cancelado_motivo:
    'Para cancelar un pedido hay que indicar el motivo',
  CHK_customer_distributor_baja:
    'La baja del cliente en la distribuidora tiene que llevar su fecha',
  CHK_order_item_cantidad:
    'La cantidad de cada renglón tiene que ser mayor a 0',
  CHK_order_item_importes: 'Los importes de un renglón no pueden ser negativos',
  UQ_order_item_pedido_producto:
    'El pedido ya tiene un renglón de esa garrafa: sumá la cantidad en el mismo renglón',
  CHK_cart_item_cantidad:
    'La cantidad de un producto en el carrito va de 1 a 999',
  CHK_cart_item_precio: 'El precio de un producto no puede ser negativo',
  // Pagos
  CHK_payment_importe: 'El importe del pago tiene que ser mayor a 0',
  CHK_payment_refund_importe:
    'El importe del reintegro tiene que ser mayor a 0',
  CHK_payment_refund_intentos:
    'Los intentos de un reintegro no pueden ser negativos',
  CHK_payment_refund_exito_fecha:
    'Un reintegro exitoso tiene que tener la fecha en que se devolvió',
  // Caja, cuentas corrientes, rendiciones y comisiones
  CHK_cash_session_montos:
    'Los importes de apertura y de arqueo no pueden ser negativos',
  CHK_cash_session_cierre_fecha:
    'La fecha de cierre sólo corresponde a una sesión cerrada (y es obligatoria en ese caso)',
  CHK_cash_session_cierre_completo:
    'Una sesión de caja cerrada necesita quién la cerró, lo contado, lo esperado y su diferencia',
  CHK_cash_session_periodo:
    'La sesión de caja no puede cerrarse antes de haberse abierto',
  CHK_customer_account_plazo_maximo:
    'El plazo de pago de la cuenta corriente no puede superar los 365 días',
  CHK_customer_account_cerrada_sin_saldo:
    'Una cuenta corriente con saldo no se puede cerrar',
  CHK_customer_account_cuit: 'El CUIT de la cuenta corriente no es válido',
  CHK_customer_account_entry_vencimiento:
    'El vencimiento no puede ser anterior a la fecha del asiento',
  CHK_driver_settlement_montos:
    'Los importes de la rendición no pueden ser negativos',
  CHK_driver_settlement_presentada:
    'Una rendición presentada necesita la fecha de presentación y el efectivo declarado',
  CHK_driver_settlement_aprobada:
    'La fecha de aprobación sólo corresponde a una rendición aprobada (y es obligatoria en ese caso)',
  CHK_driver_settlement_diferencia:
    'La diferencia de la rendición no coincide con declarado + gastos - esperado',
  CHK_driver_settlement_order_importe:
    'El importe de un pedido rendido no puede ser negativo',
  CHK_driver_settlement_collection_importe:
    'El importe de un cobro rendido tiene que ser mayor a 0',
  CHK_driver_liquidation_periodo:
    'El período de la liquidación empieza después de terminar',
  CHK_driver_liquidation_montos:
    'Los montos de la liquidación no cierran: neto = bruto - deducciones, sin negativos',
  CHK_driver_liquidation_aprobada:
    'Una liquidación aprobada o pagada necesita la fecha de aprobación',
  CHK_driver_liquidation_pagada:
    'La fecha de pago sólo corresponde a una liquidación pagada (y es obligatoria en ese caso)',
  CHK_driver_liquidation_anulada:
    'La fecha de anulación sólo corresponde a una liquidación anulada (y es obligatoria en ese caso)',
  CHK_commission_rule_porcentaje:
    'Una comisión porcentual no puede superar el 100 %',
  CHK_commission_entry_importe: 'El importe de la comisión no puede ser 0',
  CHK_commission_entry_signo:
    'El signo de la comisión no corresponde a su tipo (la comisión por entrega suma; el faltante resta)',
  EXC_commission_rule_solapada:
    'Se solapa con otra regla de comisión vigente del mismo alcance: cerrá esa regla antes de crear o cambiar ésta',
  // Catálogo y envases
  CHK_gas_cylinder_valores:
    'El precio y el peso tienen que ser mayores a 0; el stock, el déficit y el costo no pueden ser negativos',
  CHK_gas_cylinder_tipo: 'El tipo de garrafa no puede estar vacío',
  UQ_gas_cylinder_tipo_normalizado:
    'Ya existe una garrafa con ese tipo (no se distinguen mayúsculas ni espacios)',
  CHK_promocion_descuento: 'El descuento de una promoción va de 0,01 % a 99 %',
  CHK_cylinder_garantia: 'La garantía del envase no puede ser negativa',
  CHK_cylinder_cliente_segun_estado:
    'Un envase está con un cliente si y sólo si su estado es «con cliente»',
  CHK_cylinder_vencimiento:
    'El vencimiento del envase no puede ser anterior a su fabricación',
  CHK_cylinder_serial: 'El serial del envase no puede estar vacío',
  UQ_cylinder_serial_normalizado:
    'Ya existe un envase con ese serial (no se distinguen mayúsculas ni espacios)',
  CHK_cylinder_movement_cambio:
    'El movimiento del envase tiene que cambiar de estado (o llevar una nota si es una anotación del historial)',
  CHK_payment_estado_no_retrocede:
    'El estado de un pago no retrocede: un pago aprobado sólo puede pasar a reclamo, devuelto o contracargo',
  CHK_payment_historial_solo_crece:
    'El historial de estados de un pago sólo se agrega: no se quitan ni se cambian entradas',
  CHK_payment_detalle_del_estado:
    'El motivo del estado del pago no puede estar vacío',
  CHK_payment_historial_es_lista:
    'El historial de estados del pago tiene que ser una lista',
  CHK_cylinder_inspection_vencimiento:
    'El próximo vencimiento tiene que ser posterior a la revisión',
  CHK_cylinder_inspection_proxima:
    'Una revisión que no es rechazada necesita la fecha del próximo vencimiento',
  CHK_stock_movement_origen_destino_distintos:
    'El movimiento de stock tiene que cambiar de lugar o de condición',
  CHK_stock_adjustment_notas: 'El ajuste de stock necesita una nota',
  CHK_customer_container_account_owned:
    'La cantidad de envases propios no puede ser negativa',
  CHK_customer_container_movement_quantity:
    'El movimiento de envases tiene que tener una cantidad distinta de cero',
  CHK_customer_container_movement_note:
    'El ajuste de envases necesita una nota de entre 10 y 500 caracteres',
  // Compras
  CHK_purchase_order_cancelada:
    'Una orden de compra cancelada necesita el motivo',
  CHK_purchase_order_cerrada_corta:
    'Una orden de compra cerrada con faltante necesita el motivo',
  CHK_purchase_order_emitida:
    'Una orden de compra emitida necesita la fecha de emisión',
  CHK_purchase_order_total:
    'El total de la orden de compra no puede ser negativo',
  CHK_purchase_receipt_total: 'El total de la recepción no puede ser negativo',
  CHK_purchase_receipt_anulada_fecha:
    'La fecha de anulación sólo corresponde a una recepción anulada (y es obligatoria en ese caso)',
  CHK_purchase_receipt_anulacion_datos:
    'Una recepción anulada necesita el motivo y quién la anuló',
  CHK_supplier_cuit: 'El CUIT del proveedor no es válido',
  // Cargas de camión
  CHK_truck_load_salida:
    'Una carga en ruta o posterior necesita la fecha de salida',
  CHK_truck_load_regreso:
    'Una carga regresada o cerrada necesita la fecha de regreso',
  CHK_truck_load_cierre:
    'Una carga cerrada o cancelada necesita la fecha de cierre',
  CHK_truck_load_cancelada: 'Una carga cancelada necesita el motivo',
  // Flota
  CHK_traffic_fine_pago_voluntario:
    'El pago voluntario tiene que ser mayor a 0 y no superar el importe de la multa',
  CHK_traffic_fine_importe_pagado: 'El importe pagado tiene que ser mayor a 0',
  CHK_traffic_fine_pagada_datos:
    'Una multa pagada necesita la fecha y el importe del pago',
  CHK_traffic_fine_anulada_fecha:
    'Una multa anulada necesita la fecha de anulación',
  CHK_fuel_load_precio: 'El precio por litro tiene que ser mayor a 0',
  CHK_fuel_load_odometro: 'El odómetro no puede ser negativo',
  CHK_vehicle_accident_montos:
    'Los importes del siniestro no pueden ser negativos ni el reintegro superar el costo de reparación',
  CHK_vehicle_accident_cerrado_fecha:
    'Un siniestro cerrado necesita la fecha de cierre',
  CHK_maintenance_task_valores:
    'El costo, los kilómetros y el odómetro de la tarea no pueden ser negativos',
  CHK_maintenance_task_un_sujeto:
    'La tarea tiene que ser de un vehículo, de un chofer o de un empleado (uno solo)',
  CHK_maintenance_task_hecha_fecha:
    'Una tarea realizada necesita la fecha en que se hizo',
  CHK_tire_valores:
    'El costo, los kilómetros y los recapados del neumático no pueden ser negativos',
  CHK_tire_montaje:
    'Un neumático montado necesita vehículo y posición (y uno que no está montado no los tiene)',
  CHK_window_proposal_ventana:
    'La ventana de taller tiene que terminar después de empezar',
  CHK_window_proposal_respuesta:
    'Una propuesta respondida lleva la fecha de respuesta y, si se rechaza, el motivo',
  CHK_window_proposal_alternativa:
    'La alternativa del chofer es una ventana completa que termina después de empezar',
  UQ_window_proposal_caso_pendiente:
    'El caso ya tiene una propuesta esperando respuesta del chofer',
  UQ_window_proposal_caso_orden: 'El caso ya tiene una propuesta con ese orden',
  CHK_planning_case_ventana:
    'La ventana elegida tiene que ser completa y terminar después de empezar',
  CHK_planning_case_estado:
    'El estado del caso no coincide con sus datos (escalado, acordado o confirmado)',
  UQ_planning_case_tarea_abierto:
    'La tarea ya tiene un caso de planificación abierto',
  CHK_module_config_despacho:
    'Algún parámetro del despacho está fuera de su rango',
  CHK_module_config_planificador:
    'Algún parámetro del planificador de flota está fuera de su rango',
  CHK_vehicle_usage_log_valores:
    'Los kilómetros, pedidos y horas de ruta no pueden ser negativos',
  CHK_vehicle_assignment_periodo:
    'La liberación del vehículo no puede ser anterior a su asignación',
  EXC_vehicle_assignment_vehiculo_solapada:
    'El vehículo ya está asignado a otro chofer en ese período',
  EXC_vehicle_assignment_chofer_solapada:
    'El chofer ya tiene otro vehículo asignado en ese período',
  CHK_car_patente:
    'La patente no es válida: tiene que ser AAA123 o AA123AA, en mayúsculas y sin espacios',
  UQ_car_patente_distribuidora_vigente:
    'Ya hay un vehículo vigente con esa patente en la distribuidora',
  // Personas
  CHK_delivery_calificacion: 'La calificación va de 0 a 5',
  CHK_customer_consumo: 'El consumo mensual tiene que ser mayor a 0',
  CHK_customer_aviso_recompra:
    'Los días de aviso de recompra tienen que estar entre 1 y 30',
  CHK_module_config_recompra:
    'Algún parámetro de la recompra anticipada está fuera de su rango',
  UQ_repurchase_invitation_abierta:
    'El cliente ya tiene una invitación de recompra abierta',
  CHK_employee_nacimiento:
    'La fecha de nacimiento tiene que ser anterior a la de ingreso',
  CHK_employee_cuil: 'El CUIL no es válido',
  CHK_employee_email: 'El correo personal no es válido',
  CHK_employee_cbu: 'El CBU tiene que tener 22 dígitos',
  CHK_user_telefono:
    'El teléfono tiene que estar en formato internacional (E.164), por ejemplo +5493794123456',
  CHK_user_email: 'El correo no es válido',
  UQ_user_email_minusculas:
    'Ya existe un usuario con ese correo (no se distinguen mayúsculas)',
  CHK_rating_valores:
    'La calificación va de 1 a 5 estrellas, no puede ser a uno mismo y, si se oculta, lleva fecha',
  UQ_user_address_principal: 'El usuario ya tiene otra dirección principal',
  // Agenda y zonas
  CHK_time_slot_horario: 'La hora de inicio tiene que ser anterior a la de fin',
  CHK_time_slot_capacidad: 'La capacidad de la franja tiene que ser mayor a 0',
  UQ_time_slot_nombre_activa: 'Ya existe una franja con ese nombre',
  EXC_time_slot_solapada:
    'La franja se solapa con otra franja activa de la distribuidora',
  EXC_employee_attendance_solapada:
    'La jornada se solapa con otra jornada del mismo empleado',
  CHK_coverage_zone_vigencia:
    'La vigencia de la zona tiene que terminar después de empezar',
  UQ_coverage_zone_nombre_activa: 'Ya existe una zona activa con ese nombre',
  UQ_coverage_zone_prioridad_activa:
    'Ya existe una zona activa con esa prioridad: cada zona tiene una prioridad distinta',
  CHK_route_batch_stop_secuencia: 'El orden de la parada empieza en 1',
  UQ_route_batch_stop_secuencia: 'Ya hay otra parada con ese orden en la ruta',
  UQ_route_batch_stop_pedido_activo:
    'El pedido ya está en otra hoja o recorrido',
  CHK_route_batch_stop_ventana:
    'La franja estimada de la parada tiene que tener inicio y fin, y terminar después de empezar',
  CHK_route_batch_stop_salida:
    'Una parada que salió de la hoja necesita el motivo y la fecha de salida, y al revés',
  CHK_route_batch_stop_tramo_min: 'El tramo de la parada no puede ser negativo',
  CHK_route_plan_propuesta:
    'Una planificación con la propuesta armada necesita la fecha de la propuesta (una planificación abierta se puede cerrar sin propuesta)',
  CHK_route_plan_cierre:
    'La planificación cerrada necesita su fecha de cierre, y sólo ella',
  UQ_route_plan_dia:
    'Ya hay una planificación de ese día para la distribuidora',
  CHK_route_batch_hoja_fecha:
    'Sólo la hoja de ruta lleva fecha de reparto, y toda hoja de ruta la lleva',
  CHK_route_batch_estados_oferta:
    'Un lote ofrecido no puede estar en borrador ni confirmado',
  CHK_route_batch_estados_hoja:
    'Una hoja de ruta no puede estar formándose ni ofrecida',
  CHK_route_batch_hoja_confirmada:
    'Una hoja confirmada necesita chofer, vehículo y la fecha de confirmación',
  CHK_route_batch_hoja_iniciada:
    'Una hoja en curso necesita la fecha de inicio',
  CHK_route_batch_unidades: 'Las garrafas de la hoja no pueden ser negativas',
  CHK_route_batch_pico: 'El pico de envases de la hoja no puede ser negativo',
  CHK_route_batch_totales:
    'La distancia y la duración de la hoja no pueden ser negativas',
  CHK_route_batch_hoja_numero:
    'Sólo la hoja de ruta lleva número, y empieza en 1',
  CHK_route_batch_metodo:
    'El método de orden de la hoja tiene que ser nn_2opt o manual',
  CHK_route_batch_matriz:
    'El origen de los tiempos de la hoja tiene que ser osrm, google o haversine',
  CHK_route_batch_propuesta_por:
    'Quien propuso la hoja tiene que ser el sistema o un administrador',
  UQ_route_batch_hoja_chofer_dia:
    'El chofer ya tiene otra hoja de ruta confirmada o en curso ese día',
  UQ_route_batch_hoja_vehiculo_dia:
    'El vehículo ya tiene otra hoja de ruta confirmada o en curso ese día',
  UQ_route_batch_numero: 'Ya existe una hoja con ese número',
  CHK_car_max_cylinders:
    'La cantidad de garrafas del vehículo tiene que ser mayor que cero',
  CHK_module_config_hoja_de_ruta:
    'Algún parámetro de la hoja de ruta está fuera de su rango',
  CHK_order_dispatch_offer_vencimiento:
    'La oferta tiene que vencer después de ofrecerse',
  UQ_order_dispatch_offer_viva:
    'Ya hay una oferta vigente de este pedido para ese chofer',
  UQ_order_dispatch_offer_aceptada: 'El pedido ya tiene una oferta aceptada',
  CHK_document_sequence_valores: 'La numeración del documento no es válida',
  // Formatos
  CHK_distributor_cuit:
    'El CUIT de la distribuidora tiene que tener 11 dígitos, sin guiones',
  CHK_distributor_slug:
    'El identificador de la distribuidora sólo admite minúsculas, números y guiones',
  CHK_distributor_cbu:
    'El CBU de la distribuidora tiene que tener 22 dígitos con los verificadores correctos',
  CHK_distributor_alias:
    'El alias de la distribuidora tiene entre 6 y 20 caracteres: letras, números, punto y guion',
  CHK_distributor_titular:
    'El titular de la cuenta de la distribuidora tiene que tener al menos 2 caracteres',
  CHK_warehouse_codigo:
    'El código del depósito admite hasta 12 caracteres: mayúsculas, números, guion y guion bajo',
  CHK_claims_textos:
    'El motivo y la descripción del reclamo no pueden estar vacíos',
  CHK_incident_descripcion: 'La descripción del incidente no puede estar vacía',
  EXC_driver_liquidation_periodo_solapado:
    'El período se superpone con otra liquidación del mismo chofer que no está anulada',
  CHK_customer_account_allocation_tope:
    'Lo imputado a un asiento de la cuenta corriente no puede superar su importe',
  // Largo de los textos, importes y fechas (tanda V2)
  CHK_claims_largo_de_textos:
    'El motivo del reclamo admite hasta 120 caracteres; la descripción y la resolución, hasta 1000',
  CHK_incident_largo_de_textos:
    'La descripción y la resolución de la incidencia admiten hasta 1000 caracteres',
  CHK_rating_largo_de_textos:
    'El comentario y el motivo de moderación de una calificación admiten hasta 500 caracteres',
  CHK_order_nota_de_impago_largo:
    'La nota de resolución del impago admite entre 10 y 500 caracteres',
  CHK_traffic_fine_pago_contra_importe:
    'Lo pagado de una multa no puede superar su importe',
  CHK_purchase_order_fecha_esperada:
    'La fecha esperada de entrega no puede ser anterior al día en que se creó la orden',
  CHK_customer_account_entry_cobro_mayor_a_la_deuda:
    'El cobro supera la deuda de la cuenta corriente: registrá una nota de crédito por la diferencia',
  CHK_cylinder_fabricacion_futura:
    'La fecha de fabricación del envase no puede ser futura',
  CHK_driver_settlement_fecha_futura:
    'No se puede abrir la rendición de un día futuro',
  CHK_fuel_load_odometro_monotono:
    'El kilometraje de la carga no encaja entre el de la carga anterior y el de la siguiente; si es una corrección, indicá la nota',
  CHK_maintenance_task_odometro_monotono:
    'El kilometraje de la tarea no encaja entre el de la tarea anterior y el de la siguiente del vehículo',
  CHK_tire_event_odometro_monotono:
    'El kilometraje del movimiento es menor que el último del neumático en ese vehículo',
  // Transiciones de estado (triggers de la base)
  CHK_order_transicion_de_estado:
    'El pedido no puede pasar a ese estado desde el estado en que está',
  CHK_cylinder_transicion_de_estado:
    'El envase no puede pasar a ese estado desde el estado en que está',
  CHK_driver_settlement_transicion_de_estado:
    'La rendición no puede pasar a ese estado desde el estado en que está',
  CHK_driver_liquidation_transicion_de_estado:
    'La liquidación no puede pasar a ese estado desde el estado en que está',
  CHK_purchase_order_transicion_de_estado:
    'La orden de compra no puede pasar a ese estado desde el estado en que está',
  CHK_truck_load_transicion_de_estado:
    'La carga del camión no puede pasar a ese estado desde el estado en que está',
  CHK_claims_transicion_de_estado:
    'El reclamo no puede pasar a ese estado desde el estado en que está',
  CHK_customer_account_transicion_de_estado:
    'La cuenta corriente no puede pasar a ese estado desde el estado en que está',
  CHK_order_dispatch_offer_transicion_de_estado:
    'La oferta de despacho no puede pasar a ese estado desde el estado en que está',
  CHK_route_batch_transicion_de_estado:
    'El lote de recorrido no puede pasar a ese estado desde el estado en que está',
  // Cajas de cobro de las ventas
  CHK_cash_collection_settings_mercadopago_billetera:
    'La caja de Mercado Pago tiene que ser una billetera',
  CHK_cash_collection_settings_transferencia_banco:
    'La caja de transferencias tiene que ser una cuenta de banco',
  UQ_cash_movement_cobro_de_venta:
    'Ese cobro, comisión, devolución o transferencia ya está asentado en una caja',
  // Saldos contra el libro (constraint triggers diferidos)
  CHK_cash_box_saldo_contra_libro:
    'El saldo de la caja no coincide con la suma de sus movimientos: la operación se deshizo',
  CHK_stock_balance_saldo_contra_libro:
    'La existencia no coincide con la suma de los movimientos de stock: la operación se deshizo',
  CHK_customer_account_saldo_contra_libro:
    'El saldo de la cuenta corriente no coincide con la suma de sus asientos: la operación se deshizo',

  // Bandeja de avisos del administrador
  UQ_admin_notification_dedupe: 'Ese aviso ya está en la bandeja',
  CHK_admin_notification_texto:
    'El aviso necesita tipo, título y clave que no estén vacíos',
  CHK_admin_notification_destino:
    'El destino del aviso lleva entidad e id, o ninguno de los dos',

  // Seguros de los vehículos
  CHK_insurer_cuit: 'El CUIT de la aseguradora no es válido',
  CHK_insurer_enlaces:
    'El enlace de pago tiene que ser https y la web, http o https',
  CHK_insurer_nombre: 'El nombre de la aseguradora necesita al menos 2 letras',
  UQ_insurer_nombre_vigente: 'Ya hay una aseguradora con ese nombre',
  CHK_insurance_policy_vigencia:
    'La póliza tiene que vencer después de que empieza',
  CHK_insurance_policy_cancelada:
    'Una póliza cancelada necesita la fecha y el motivo',
  CHK_insurance_policy_textos:
    'El número de póliza y la cobertura no pueden estar vacíos',
  UQ_insurance_policy_numero_vigente:
    'Ya hay una póliza con ese número para la aseguradora',
  EXC_insurance_policy_solapada:
    'El vehículo ya tiene una póliza vigente en esas fechas: cancelala o renová desde su vencimiento',
  CHK_insurance_installment_importe:
    'El importe de la cuota tiene que ser mayor a 0',
  CHK_insurance_installment_numero:
    'El número de cuota tiene que estar entre 1 y el total',
  CHK_insurance_installment_gracia:
    'La gracia no puede ser anterior al vencimiento de la cuota',
  CHK_insurance_installment_pagada:
    'Una cuota paga necesita la fecha, el importe, quién pagó, el egreso de caja y el comprobante',
  UQ_insurance_installment_numero: 'La póliza ya tiene esa cuota',
  // Roles del personal del panel (F37)
  UQ_staff_role_nombre_vigente: 'Ya existe un rol con ese nombre',
  UQ_staff_role_sistema_vigente:
    'La distribuidora ya tiene su rol de sistema «Administrador»',
  UQ_staff_role_id_distribuidora: 'El rol ya existe en la distribuidora',
  CHK_staff_role_nombre: 'El nombre del rol tiene que tener al menos 2 letras',
  CHK_staff_role_sistema_sin_lista:
    'El rol de sistema tiene todos los permisos: no lleva una lista propia',
  // Modo soporte del administrador general
  UQ_support_session_activa:
    'Ya tenés una sesión de soporte activa: salí de esa antes de abrir otra',
  UQ_support_session_pendiente:
    'Ya hay un pedido de soporte pendiente para esa empresa',
  CHK_support_session_motivo:
    'El motivo del acceso de soporte tiene que tener entre 20 y 1000 caracteres',
  CHK_support_session_alcance:
    'El alcance del soporte sólo admite datos personales, archivos y exportes',
  CHK_support_session_minutos:
    'La duración del soporte tiene que ser de 15, 30, 60 o 120 minutos',
  CHK_support_session_pendiente:
    'Un pedido de soporte pendiente necesita su plazo de respuesta',
  CHK_support_session_activa:
    'Una sesión de soporte que empezó necesita su inicio y su vencimiento',
  CHK_support_session_duracion:
    'Una sesión de soporte dura como máximo 120 minutos (60 en emergencia)',
  CHK_support_session_emergencia:
    'Un acceso de emergencia no lleva aprobación de la empresa',
  CHK_support_session_fin:
    'Una sesión de soporte terminada necesita cuándo y por qué terminó',
  CHK_support_session_motivo_de_fin:
    'El motivo de fin de la sesión de soporte no es válido',
  CHK_admin_rol_de_personal:
    'Todo administrador de una distribuidora tiene que tener un rol de personal (y el super administrador, ninguno)',
};

/** Las claves foráneas compuestas (id, distribuidora) se nombran `FK_<tabla>_<columna>_distribuidora`. */
const FK_DE_DISTRIBUIDORA = /^FK_[a-z0-9_]+_distribuidora$/;

/**
 * Violaciones que no son un dato mal cargado sino un choque con el estado actual
 * (transición inválida, saldo que no cierra con el libro): 409 y no 400.
 */
const CONFLICTO_DE_ESTADO =
  /_(transicion_de_estado|saldo_contra_libro|cobro_mayor_a_la_deuda)$/;

export function esConflictoDeEstado(restriccion: string | undefined): boolean {
  return restriccion !== undefined && CONFLICTO_DE_ESTADO.test(restriccion);
}

/** Mensaje de una restricción conocida, o `undefined` si no la conocemos. */
export function mensajeDeRestriccion(
  restriccion: string | undefined,
): string | undefined {
  if (!restriccion) return undefined;
  if (FK_DE_DISTRIBUIDORA.test(restriccion)) {
    return 'El registro elegido pertenece a otra distribuidora';
  }
  return MENSAJES_DE_RESTRICCIONES[restriccion];
}
