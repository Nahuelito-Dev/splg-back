/**
 * Reglas de datos que la base verifica con triggers (no se pueden expresar como
 * CHECK porque miran otras filas o el reloj). Las crea la migración
 * `ReglasDelBackEnLaBase` y también el arranque de la base de las pruebas de
 * integración. Cada una falla con SQLSTATE 23514 y la restricción indicada
 * (`CHK_*`), que `traducirErrorDeBase` traduce a 400; el cobro mayor que la deuda
 * (`..._cobro_mayor_a_la_deuda`) choca con el estado de la cuenta y sale 409.
 *
 *  - un cobro de cuenta corriente no supera la deuda que tiene la cuenta;
 *  - la fabricación de un envase no es futura;
 *  - la rendición no se abre para un día que no llegó;
 *  - los odómetros no van hacia atrás: cargas de combustible (contra la anterior
 *    y la siguiente, salvo corrección con nota), cierres de tareas de
 *    mantenimiento (contra las hechas antes y después del mismo vehículo) y
 *    movimientos de un neumático (contra los suyos en el mismo vehículo).
 *
 * Bypass para seeds y fixtures: `SET LOCAL splg.bypass_saldos = on` (cobro) y
 * `SET LOCAL splg.bypass_reglas = on` (el resto).
 */
const BYPASS_REGLAS = `IF current_setting('splg.bypass_reglas', true) = 'on' THEN RETURN NEW; END IF;`;

const FUNCIONES = [
  `CREATE FUNCTION cobro_de_cuenta_maximo() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE v_deuda numeric;
       BEGIN
         IF current_setting('splg.bypass_saldos', true) = 'on' THEN RETURN NEW; END IF;
         SELECT coalesce(sum(CASE WHEN "type" IN ('sale_charge', 'debit_note') THEN "amount" ELSE -"amount" END), 0) INTO v_deuda
           FROM "customer_account_entry" WHERE "account_id" = NEW."account_id";
         IF NEW."amount" > v_deuda THEN
           RAISE EXCEPTION 'El cobro (%) supera la deuda de la cuenta (%)', NEW."amount", v_deuda
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_customer_account_entry_cobro_mayor_a_la_deuda';
         END IF;
         RETURN NEW;
       END $$`,
  `CREATE FUNCTION fabricacion_de_envase_no_futura() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         ${BYPASS_REGLAS}
         IF NEW."manufactured_at" IS NOT NULL
            AND (TG_OP = 'INSERT' OR NEW."manufactured_at" IS DISTINCT FROM OLD."manufactured_at")
            AND NEW."manufactured_at" > now() + interval '5 minutes' THEN
           RAISE EXCEPTION 'La fecha de fabricación del envase (%) es futura', NEW."manufactured_at"
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_cylinder_fabricacion_futura';
         END IF;
         RETURN NEW;
       END $$`,
  `CREATE FUNCTION rendicion_sin_fecha_futura() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         ${BYPASS_REGLAS}
         IF NEW."business_date" > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date THEN
           RAISE EXCEPTION 'No se abre la rendición de un día futuro (%)', NEW."business_date"
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_driver_settlement_fecha_futura';
         END IF;
         RETURN NEW;
       END $$`,
  `CREATE FUNCTION odometro_de_carga_monotono() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE v_anterior integer; v_siguiente integer;
       BEGIN
         ${BYPASS_REGLAS}
         IF NEW."deletedAt" IS NOT NULL OR NEW."odometer_correction_note" IS NOT NULL THEN RETURN NEW; END IF;
         SELECT "odometer_km" INTO v_anterior FROM "fuel_load"
           WHERE "car_id" = NEW."car_id" AND "deletedAt" IS NULL AND "fuel_load_id" <> NEW."fuel_load_id" AND "loaded_at" <= NEW."loaded_at"
           ORDER BY "loaded_at" DESC, "odometer_km" DESC LIMIT 1;
         SELECT "odometer_km" INTO v_siguiente FROM "fuel_load"
           WHERE "car_id" = NEW."car_id" AND "deletedAt" IS NULL AND "fuel_load_id" <> NEW."fuel_load_id" AND "loaded_at" > NEW."loaded_at"
           ORDER BY "loaded_at" ASC, "odometer_km" ASC LIMIT 1;
         IF (v_anterior IS NOT NULL AND NEW."odometer_km" < v_anterior)
            OR (v_siguiente IS NOT NULL AND NEW."odometer_km" > v_siguiente) THEN
           RAISE EXCEPTION 'El kilometraje de la carga (%) no encaja entre el de la carga anterior (%) y el de la siguiente (%)', NEW."odometer_km", v_anterior, v_siguiente
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_fuel_load_odometro_monotono';
         END IF;
         RETURN NEW;
       END $$`,
  `CREATE FUNCTION odometro_de_tarea_monotono() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE v_anterior integer; v_siguiente integer;
       BEGIN
         ${BYPASS_REGLAS}
         IF NEW."status" <> 'done' OR NEW."odometer_km" IS NULL OR NEW."car_id" IS NULL OR NEW."performed_at" IS NULL THEN RETURN NEW; END IF;
         SELECT "odometer_km" INTO v_anterior FROM "maintenance_task"
           WHERE "car_id" = NEW."car_id" AND "status" = 'done' AND "odometer_km" IS NOT NULL AND "task_id" <> NEW."task_id" AND "performed_at" <= NEW."performed_at"
           ORDER BY "performed_at" DESC, "odometer_km" DESC LIMIT 1;
         SELECT "odometer_km" INTO v_siguiente FROM "maintenance_task"
           WHERE "car_id" = NEW."car_id" AND "status" = 'done' AND "odometer_km" IS NOT NULL AND "task_id" <> NEW."task_id" AND "performed_at" > NEW."performed_at"
           ORDER BY "performed_at" ASC, "odometer_km" ASC LIMIT 1;
         IF (v_anterior IS NOT NULL AND NEW."odometer_km" < v_anterior)
            OR (v_siguiente IS NOT NULL AND NEW."odometer_km" > v_siguiente) THEN
           RAISE EXCEPTION 'El kilometraje de la tarea (%) no encaja entre el de la anterior (%) y el de la siguiente (%)', NEW."odometer_km", v_anterior, v_siguiente
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_maintenance_task_odometro_monotono';
         END IF;
         RETURN NEW;
       END $$`,
  `CREATE FUNCTION odometro_de_neumatico_monotono() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE v_ultimo integer;
       BEGIN
         ${BYPASS_REGLAS}
         IF NEW."car_id" IS NULL THEN RETURN NEW; END IF;
         SELECT max("odometer_km") INTO v_ultimo FROM "tire_event" WHERE "tire_id" = NEW."tire_id" AND "car_id" = NEW."car_id";
         IF v_ultimo IS NOT NULL AND NEW."odometer_km" < v_ultimo THEN
           RAISE EXCEPTION 'El kilometraje del movimiento (%) es menor que el último del neumático en el vehículo (%)', NEW."odometer_km", v_ultimo
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_tire_event_odometro_monotono';
         END IF;
         RETURN NEW;
       END $$`,
];

interface TriggerDeRegla {
  nombre: string;
  momento: string;
  tabla: string;
  funcion: string;
  cuando?: string;
}

const TRIGGERS: readonly TriggerDeRegla[] = [
  {
    nombre: 'TRG_customer_account_entry_cobro_maximo',
    momento: 'BEFORE INSERT',
    tabla: 'customer_account_entry',
    funcion: 'cobro_de_cuenta_maximo',
    cuando: `NEW."type" = 'payment'`,
  },
  {
    nombre: 'TRG_cylinder_fabricacion_no_futura',
    momento: 'BEFORE INSERT OR UPDATE OF "manufactured_at"',
    tabla: 'cylinder',
    funcion: 'fabricacion_de_envase_no_futura',
  },
  {
    nombre: 'TRG_driver_settlement_fecha_futura',
    momento: 'BEFORE INSERT',
    tabla: 'driver_settlement',
    funcion: 'rendicion_sin_fecha_futura',
  },
  {
    nombre: 'TRG_fuel_load_odometro_monotono',
    momento:
      'BEFORE INSERT OR UPDATE OF "odometer_km", "loaded_at", "car_id", "deletedAt"',
    tabla: 'fuel_load',
    funcion: 'odometro_de_carga_monotono',
  },
  {
    nombre: 'TRG_maintenance_task_odometro_monotono',
    momento:
      'BEFORE INSERT OR UPDATE OF "odometer_km", "performed_at", "status", "car_id"',
    tabla: 'maintenance_task',
    funcion: 'odometro_de_tarea_monotono',
  },
  {
    nombre: 'TRG_tire_event_odometro_monotono',
    momento: 'BEFORE INSERT',
    tabla: 'tire_event',
    funcion: 'odometro_de_neumatico_monotono',
  },
];

export function sentenciasDeReglasDeDatos(): string[] {
  return [
    ...FUNCIONES,
    ...TRIGGERS.map(
      (t) =>
        `CREATE TRIGGER "${t.nombre}" ${t.momento} ON "${t.tabla}"
         FOR EACH ROW${t.cuando ? ` WHEN (${t.cuando})` : ''} EXECUTE FUNCTION ${t.funcion}()`,
    ),
  ];
}

export function sentenciasParaQuitarReglasDeDatos(): string[] {
  return [
    ...TRIGGERS.map(
      (t) => `DROP TRIGGER IF EXISTS "${t.nombre}" ON "${t.tabla}"`,
    ),
    ...TRIGGERS.map((t) => `DROP FUNCTION IF EXISTS ${t.funcion}()`),
  ];
}

/**
 * CHECK de esta tanda (también declarados con `@Check` en las entidades) con la
 * consulta que cuenta las filas que hoy los violarían.
 */
export interface ChequeoDeDatos {
  tabla: string;
  nombre: string;
  expresion: string;
}

export const CHEQUEOS_DE_DATOS: readonly ChequeoDeDatos[] = [
  {
    tabla: 'claims',
    nombre: 'CHK_claims_largo_de_textos',
    expresion: `char_length("reason") <= 120 AND char_length("description") <= 1000 AND ("resolutionNote" IS NULL OR char_length("resolutionNote") <= 1000)`,
  },
  {
    tabla: 'incident',
    nombre: 'CHK_incident_largo_de_textos',
    expresion: `char_length("description") <= 1000 AND ("resolution_note" IS NULL OR char_length("resolution_note") <= 1000)`,
  },
  {
    tabla: 'rating',
    nombre: 'CHK_rating_largo_de_textos',
    expresion: `("comment" IS NULL OR char_length("comment") <= 500) AND ("hidden_reason" IS NULL OR char_length("hidden_reason") <= 500)`,
  },
  {
    tabla: 'order',
    nombre: 'CHK_order_nota_de_impago_largo',
    expresion: `"payment_resolution_note" IS NULL OR (char_length("payment_resolution_note") <= 500 AND char_length(btrim("payment_resolution_note")) >= 10)`,
  },
  {
    tabla: 'traffic_fine',
    nombre: 'CHK_traffic_fine_pago_contra_importe',
    expresion: `"paid_amount" IS NULL OR "paid_amount" <= "amount"`,
  },
  {
    tabla: 'purchase_order',
    nombre: 'CHK_purchase_order_fecha_esperada',
    expresion: `"expected_date" IS NULL OR "expected_date" >= ("createdAt" AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`,
  },
];
