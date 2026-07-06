import * as Joi from 'joi';

export const JoiValidationSchema = Joi.object({
  DB_PASSWORD: Joi.required(),
  DB_NAME: Joi.required(),
  DB_HOST: Joi.required(),
  DB_PORT: Joi.number().default(5433),
  DB_USERNAME: Joi.required(),
  // MercadoPago Checkout Pro. Opcionales para no romper entornos (tests/CI)
  // sin credenciales sandbox configuradas; en runtime real deben setearse.
  MP_ACCESS_TOKEN: Joi.string().optional(),
  MP_WEBHOOK_SECRET: Joi.string().optional(),
  MP_NOTIFICATION_URL: Joi.string().optional(),
  MP_SUCCESS_URL: Joi.string().optional(),
  MP_FAILURE_URL: Joi.string().optional(),
  MP_PENDING_URL: Joi.string().optional(),
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
