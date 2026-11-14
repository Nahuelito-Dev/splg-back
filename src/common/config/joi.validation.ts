import * as Joi from 'joi';

export const JoiValidationSchema = Joi.object({
  // Entorno de ejecución. Sólo `development` y `test` sirven la documentación
  // sin credenciales; cualquier otro (o ninguno) falla cerrado.
  NODE_ENV: Joi.string().valid('development', 'test', 'production').optional(),
  DB_PASSWORD: Joi.required(),
  DB_NAME: Joi.required(),
  DB_HOST: Joi.required(),
  DB_PORT: Joi.number().default(5433),
  DB_USERNAME: Joi.required(),
  // Distribuidora de los clientes que todavía no mandan X-Distributor.
  DEFAULT_DISTRIBUTOR_SLUG: Joi.string().default('demo'),
  // Horas que una reserva espera el pago de la seña antes de vencer.
  RESERVATION_DEPOSIT_TTL_HOURS: Joi.number().integer().min(1).default(48),
  // Minutos que un pedido con MercadoPago espera el pago antes de vencer.
  ORDER_MERCADOPAGO_PENDING_TTL_MINUTES: Joi.number()
    .integer()
    .min(1)
    .default(60),
  // Horas que un pedido de Mercado Pago cancelado se sigue revisando por si entra un
  // pago tardío (se devuelve aunque su aviso se haya perdido).
  // Días que se conservan los avisos de Mercado Pago ya procesados en la bandeja de entrada.
  PAYMENT_INBOX_RETENTION_DAYS: Joi.alternatives(
    Joi.number().valid(0),
    Joi.number().integer().min(7),
  ).default(0),
  ORDER_MERCADOPAGO_CANCELLED_SWEEP_HOURS: Joi.number()
    .integer()
    .min(1)
    .default(48),
  // Días que se conserva el historial de corridas de los procesos automáticos (siempre queda la última de cada uno).
  PROCESS_RUN_RETENTION_DAYS: Joi.number().integer().min(1).default(30),
  // Minutos que una corrida puede seguir en curso antes de darla por colgada.
  PROCESS_RUN_STUCK_MINUTES: Joi.number().integer().min(1).default(30),
  // Umbral de RSS de /health (H-53): 300 MB era el de un proceso recién
  // levantado, no el de uno trabajando (con tráfico real lo supera y el
  // load balancer lo sacaba de servicio). 512 MB da margen para la carga
  // normal de este proceso Node/Nest sin dejar de detectar una fuga real.
  HEALTH_MEMORY_RSS_THRESHOLD_MB: Joi.number().integer().min(1).default(512),
  // Firebase Admin: sin estas tres no se pueden verificar los tokens.
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().required(),
  FIREBASE_PRIVATE_KEY: Joi.string().required(),
  // La plataforma (dueña del sistema): nombre, razón social y correo del soporte.
  // Sin ellas, el nombre neutro «SPLG» (ver plataforma.config.ts).
  PLATFORM_NAME: Joi.string().trim().max(80).empty('').optional(),
  PLATFORM_LEGAL_NAME: Joi.string().trim().max(160).empty('').optional(),
  PLATFORM_SUPPORT_EMAIL: Joi.string().trim().email().empty('').optional(),
  // SDK de cliente, para el acceso con email y contraseña.
  FIREBASE_APP_API_KEY: Joi.string().optional(),
  // Dominio de la app en los links de los correos; por defecto, el del
  // proyecto de Firebase (ver EnlacesDeLaApp).
  APP_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional(),
  // Rutas por calles (`GET /routes/driving`): clave de la Routes API de Google DEL
  // SERVIDOR (sin ella se usa OSRM) y, opcional, otro servidor OSRM.
  GOOGLE_DIRECTIONS_API_KEY: Joi.string().empty('').optional(),
  OSRM_BASE_URL: Joi.string()
    .empty('')
    .uri({ scheme: ['http', 'https'] })
    .optional(),
  // Topes de `GET /routes/driving` (cada consulta que llega al proveedor gasta
  // cuota de Google): por usuario y por distribuidora cada 24 h, y distancia
  // máxima entre `from` y la última posición del chofer.
  ROUTES_DAILY_LIMIT_PER_USER: Joi.number().integer().min(1).default(100),
  ROUTES_DAILY_LIMIT_PER_DISTRIBUTOR: Joi.number()
    .integer()
    .min(1)
    .default(3000),
  ROUTES_FROM_MAX_DISTANCE_M: Joi.number().integer().min(1).default(300),
  // MercadoPago Checkout Pro. Opcionales para no romper entornos (tests/CI)
  // sin credenciales sandbox configuradas; en runtime real deben setearse.
  MP_ACCESS_TOKEN: Joi.string().optional(),
  MP_WEBHOOK_SECRET: Joi.string().optional(),
  MP_NOTIFICATION_URL: Joi.string().optional(),
  // A dónde vuelve el comprador tras pagar. Sin valor: `splg://pago/exito`,
  // `splg://pago/pendiente` y `splg://pago/error` (enlaces profundos de la app).
  MP_SUCCESS_URL: Joi.string().optional(),
  MP_FAILURE_URL: Joi.string().optional(),
  MP_PENDING_URL: Joi.string().optional(),
  // Clave de 32 bytes codificada en base64 para cifrar credenciales propias.
  // Es opcional: sin ella el sistema conserva la cuenta global y rechaza altas.
  CREDENTIALS_ENCRYPTION_KEY: Joi.string()
    .custom((value: string, helpers) =>
      Buffer.from(value, 'base64').length === 32
        ? value
        : helpers.error('any.invalid'),
    )
    .optional()
    .messages({
      'any.invalid':
        'CREDENTIALS_ENCRYPTION_KEY debe codificar exactamente 32 bytes en base64',
    }),
  // Lector de documentos (módulo M6). Sin la clave, los datos se cargan a mano.
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  LECTOR_MODELO: Joi.string().allow('').optional(),
  LECTOR_ESFUERZO: Joi.string().valid('low', 'medium', 'high', '').optional(),
  // Reporte de liberaciones (conciliación). `fake` usa un reporte de mentira
  // (sólo fuera de producción) y `MP_REPORTS_FAKE_CSV` es la ruta del CSV que devuelve.
  MP_REPORTS_DRIVER: Joi.string().valid('real', 'fake', '').optional(),
  MP_REPORTS_FAKE_CSV: Joi.string().allow('').optional(),
  // Archivos en Amazon S3 (adjuntos de flota y de empresa, foto del reclamo).
  // Bucket y región son obligatorios: sin ellos la app no arranca. Una variable
  // vacía (`AWS_S3_ENDPOINT=`) cuenta como no definida.
  AWS_S3_BUCKET: Joi.string()
    .empty('')
    .required()
    .messages({ 'any.required': 'AWS_S3_BUCKET es obligatorio' }),
  AWS_REGION: Joi.string().empty('').required().messages({
    'any.required': 'AWS_REGION es obligatorio (p. ej. sa-east-1)',
  }),
  // Opcionales: sin ellas el SDK usa la cadena por defecto de AWS (rol IAM del
  // servidor). Si se define una, tiene que estar la otra.
  AWS_ACCESS_KEY_ID: Joi.string().empty('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().empty('').optional(),
  // Sólo para S3 compatibles (MinIO en desarrollo): URL del servicio y
  // direccionamiento por path (http://host:9000/bucket/key).
  AWS_S3_ENDPOINT: Joi.string()
    .empty('')
    .uri({ scheme: ['http', 'https'] })
    .optional(),
  AWS_S3_FORCE_PATH_STYLE: Joi.boolean().default(false),
  AWS_S3_SIGNED_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(604800)
    .optional(),
  // Tope de filas por exporte (GET /api/v2/exports/:recurso). Si se pasa, 400.
  EXPORT_MAX_ROWS: Joi.number().integer().min(1).max(500000).default(50000),
  //GOOGLE_MAPS_API_KEY: Joi.string().required(),
  //MERCADO_PAGO_MARKETPLACE_API_KEY: Joi.string().required(),
  // MERCADO_PAGO_MARKETPLACE_CLIENT_ID: Joi.string().required(),
  //MERCADO_PAGO_MARKETPLACE_CLIENT_SECRET: Joi.string().required(),
  //MERCADO_PAGO_MARKETPLACE_REDIRECT_URI: Joi.string().required(),
  //MARKET_PLACE_ID: Joi.string().required(),
}).and('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY');
