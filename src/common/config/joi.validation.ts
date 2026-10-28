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
  // Umbral de RSS de /health (H-53): 300 MB era el de un proceso recién
  // levantado, no el de uno trabajando (con tráfico real lo supera y el
  // load balancer lo sacaba de servicio). 512 MB da margen para la carga
  // normal de este proceso Node/Nest sin dejar de detectar una fuga real.
  HEALTH_MEMORY_RSS_THRESHOLD_MB: Joi.number().integer().min(1).default(512),
  // Firebase Admin: sin estas tres no se pueden verificar los tokens.
  FIREBASE_PROJECT_ID: Joi.string().required(),
  FIREBASE_CLIENT_EMAIL: Joi.string().required(),
  FIREBASE_PRIVATE_KEY: Joi.string().required(),
  // SDK de cliente, para el acceso con email y contraseña.
  FIREBASE_APP_API_KEY: Joi.string().optional(),
  // Dominio de la app en los links de los correos; por defecto, el del
  // proyecto de Firebase (ver EnlacesDeLaApp).
  APP_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional(),
  // Rutas por calles (`GET /routes/driving`): clave de Google Directions DEL
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
  MP_SUCCESS_URL: Joi.string().optional(),
  MP_FAILURE_URL: Joi.string().optional(),
  MP_PENDING_URL: Joi.string().optional(),
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
