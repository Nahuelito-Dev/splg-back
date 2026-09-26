export const EnvConfiguration = () => ({
  environment: process.env.NODE_ENV || 'dev',
  db_password: process.env.DB_PASSWORD,
  db_name: process.env.DB_NAME,
  db_host: process.env.DB_HOST,
  db_port: process.env.DB_PORT,
  db_username: process.env.DB_USERNAME,
  // MercadoPago Checkout Pro (F1 pagos). Se consumen directo vía
  // ConfigService.get('MP_...') en MercadoPagoAdapter, pero se dejan acá
  // también para consistencia con el resto de la config.
  mp_access_token: process.env.MP_ACCESS_TOKEN,
  mp_webhook_secret: process.env.MP_WEBHOOK_SECRET,
  mp_notification_url: process.env.MP_NOTIFICATION_URL,
  mp_success_url: process.env.MP_SUCCESS_URL,
  mp_failure_url: process.env.MP_FAILURE_URL,
  mp_pending_url: process.env.MP_PENDING_URL,
  //aws_region: process.env.AWS_REGION,
  //aws_access_key_id: process.env.AWS_ACCESS_KEY_ID,
  //aws_secret_access_key: process.env.AWS_SECRET_ACCESS_KEY,
  //aws_public_bucket_name: process.env.AWS_PUBLIC_BUCKET_NAME,
  //google_maps_api_key: process.env.GOOGLE_MAPS_API_KEY,
  //mercado_pago_marketplace_api_key:
  //process.env.MERCADO_PAGO_MARKETPLACE_API_KEY,
  //mercado_pago_marketplace_client_id:
  //process.env.MERCADO_PAGO_MARKETPLACE_CLIENT_ID,
  //mercado_pago_marketplace_client_secret:
  //process.env.MERCADO_PAGO_MARKETPLACE_CLIENT_SECRET,
  //mercado_pago_marketplace_redirect_uri:
  //process.env.MERCADO_PAGO_MARKETPLACE_REDIRECT_URI,
  //market_place_id: process.env.MARKET_PLACE_ID,
});
