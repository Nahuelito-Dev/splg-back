/**
 * Trigger que impide que el estado de un pago retroceda. Lo crea la migración
 * `EstadoDelPagoYMovimientoDeEnvase` y también el arranque de la base de las
 * pruebas de integración (el esquema sincronizado desde las entidades no trae
 * triggers).
 */
export const CREAR_FUNCION_ESTADO_DEL_PAGO = `CREATE FUNCTION payment_estado_no_retrocede() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.status = NEW.status
            OR OLD.status = 'pending'
            OR (OLD.status = 'approved' AND NEW.status = 'refunded') THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION 'El estado del pago no puede pasar de % a %', OLD.status, NEW.status
           USING ERRCODE = '23514', CONSTRAINT = 'CHK_payment_estado_no_retrocede';
       END $$`;

export const CREAR_TRIGGER_ESTADO_DEL_PAGO = `CREATE TRIGGER "TRG_payment_estado_no_retrocede" BEFORE UPDATE OF "status" ON "payment"
         FOR EACH ROW EXECUTE FUNCTION payment_estado_no_retrocede()`;

/**
 * Los nueve estados de la API de pagos de Mercado Pago (`EstadosDelPagoDeMercadoPago`):
 * la misma máquina que `payment-status.machine.ts`. Un pago nunca retrocede.
 */
export const REEMPLAZAR_FUNCION_ESTADO_DEL_PAGO = `CREATE OR REPLACE FUNCTION payment_estado_no_retrocede() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.status = NEW.status
            OR OLD.status = 'pending'
            OR (OLD.status IN ('in_process', 'authorized') AND NEW.status IN ('in_process', 'authorized', 'approved', 'rejected', 'cancelled'))
            OR (OLD.status = 'approved' AND NEW.status IN ('in_mediation', 'refunded', 'charged_back'))
            OR (OLD.status = 'in_mediation' AND NEW.status IN ('approved', 'refunded', 'charged_back')) THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION 'El estado del pago no puede pasar de % a %', OLD.status, NEW.status
           USING ERRCODE = '23514', CONSTRAINT = 'CHK_payment_estado_no_retrocede';
       END $$`;

/** El historial de estados del pago es de sólo agregar: no se quitan ni se reescriben entradas. */
export const CREAR_FUNCION_HISTORIAL_DEL_PAGO = `CREATE OR REPLACE FUNCTION payment_historial_solo_crece() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF jsonb_array_length(NEW.status_history) >= jsonb_array_length(OLD.status_history)
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(OLD.status_history) WITH ORDINALITY o(e, i)
              WHERE (NEW.status_history -> (o.i - 1)::int) IS DISTINCT FROM o.e) THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION 'El historial de estados del pago sólo se agrega: no se quitan ni se cambian entradas'
           USING ERRCODE = '23514', CONSTRAINT = 'CHK_payment_historial_solo_crece';
       END $$`;

export const CREAR_TRIGGER_HISTORIAL_DEL_PAGO = `CREATE TRIGGER "TRG_payment_historial_solo_crece" BEFORE UPDATE OF "status_history" ON "payment"
         FOR EACH ROW EXECUTE FUNCTION payment_historial_solo_crece()`;
