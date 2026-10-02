import * as Joi from 'joi';

export const JoiValidationSchema = Joi.object({
  DB_PASSWORD: Joi.required(),
  DB_NAME: Joi.required(),
  DB_HOST: Joi.required(),
  DB_PORT: Joi.number().default(5433),
  DB_USERNAME: Joi.required(),
  // Distribuidora de los clientes que todavía no mandan X-Distributor.
  DEFAULT_DISTRIBUTOR_SLUG: Joi.string().default('jeny-gas'),
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
  // MercadoPago Checkout Pro. Opcionales para no romper entornos (tests/CI)
  // sin credenciales sandbox configuradas; en runtime real deben setearse.
  MP_ACCESS_TOKEN: Joi.string().optional(),
  MP_WEBHOOK_SECRET: Joi.string().optional(),
  MP_NOTIFICATION_URL: Joi.string().optional(),
  MP_SUCCESS_URL: Joi.string().optional(),
  MP_FAILURE_URL: Joi.string().optional(),
  MP_PENDING_URL: Joi.string().optional(),
  // Almacenamiento de archivos (flota: pólizas, VTV, licencias de choferes).
  // Con STORAGE_DRIVER=s3, el bucket/región/credenciales pasan a ser
  // obligatorios; con 'local' (default) no hace falta nada más.
  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  STORAGE_LOCAL_PATH: Joi.string().default('./storage-local'),
  STORAGE_S3_BUCKET: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  STORAGE_S3_REGION: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  STORAGE_S3_ACCESS_KEY_ID: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  STORAGE_S3_SECRET_ACCESS_KEY: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  STORAGE_S3_SIGNED_URL_TTL_SECONDS: Joi.number().integer().min(1).optional(),
  //AWS_REGION: Joi.string().required(),
  //AWS_ACCESS_KEY_ID: Joi.string().required(),
  //AWS_SECRET_ACCESS_KEY: Joi.string().required(),
  //AWS_PUBLIC_BUCKET_NAME: Joi.string().required(),
  //GOOGLE_MAPS_API_KEY: Joi.string().required(),
  //MERCADO_PAGO_MARKETPLACE_API_KEY: Joi.string().required(),
  // MERCADO_PAGO_MARKETPLACE_CLIENT_ID: Joi.string().required(),
  //MERCADO_PAGO_MARKETPLACE_CLIENT_SECRET: Joi.string().required(),
  //MERCADO_PAGO_MARKETPLACE_REDIRECT_URI: Joi.string().required(),
  //MARKET_PLACE_ID: Joi.string().required(),
});
