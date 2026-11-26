## v2.6.0 - 2026-11-26

### Funcionalidades

- **seguridad:** ✨ contraseñas seguras, helmet, revocación de sesiones y logs sin secretos (b810e38)
- **recupero:** ✨ puntaje de riesgo por cliente y retiro oportunista en las hojas del día (ad683f6)
- **despacho:** ✨ ofrecer el pedido al chofer que llega antes por calle (OSRM) (3f6bb7d)
- **recompra:** ✨ ajuste de la fecha por cliente y aviso en su franja horaria (7524789)
- **hoja-de-ruta:** ✨ tiempo de atención aprendido de las entregas reales (v3) (314986a)
- **despacho:** ✨ método de asignación del pedido y filtro por stock del vehículo (dc6b211)
- **avisos:** ✨ registro de avisos enviados (push y correo) con destino enmascarado (v3) (1eddaa2)
- **reportes:** ✨ utilización por vehículo (días en uso, km, entregas y costos) en /v3/reports/vehicle-utilization (1dde68f)
- **reportes:** ✨ GraphQL de sólo lectura para reportes y estadísticas, con los guards globales aplicados al contexto GraphQL (691f102)
- **pedidos:** «No pude entregar» para todas las entregas y nueva visita con propuesta, respuesta del cliente y decisión del admin (v3) (2074695)
- **pagos:** ✨ la transferencia sale del sistema: sin datos bancarios, comprobantes ni cobros por transferencia; lo histórico se sigue viendo (6568fd1)

### Correcciones

- **migraciones:** 🐛 sacar la transferencia no borra datos: las columnas bancarias quedan sin uso (60dbb42)

### Mejoras internas

- **envases:** ♻️ arquitectura hexagonal y DDD en el módulo de envases (e95965d)

