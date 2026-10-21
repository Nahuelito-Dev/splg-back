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
