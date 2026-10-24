/**
 * Saldos contra el libro: el saldo que guarda cada caja, cada cuenta corriente y
 * cada renglón de existencia tiene que ser la suma de sus movimientos. Lo crea la
 * migración `SaldosContraLibro` y también el arranque de la base de las pruebas
 * de integración.
 *
 * Son CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED, por fila afectada: la
 * verificación corre al commit (no a cada sentencia), cuando el saldo y el
 * movimiento ya están los dos escritos en la misma transacción. Se dispara desde
 * los dos lados: al tocar el saldo y al insertar un movimiento. Si no cierra,
 * falla el commit con SQLSTATE 23514 y la restricción `CHK_*_saldo_contra_libro`
 * (el back lo traduce a 409).
 *
 * Bypass explícito para seeds y fixtures que arman un saldo a mano:
 * `SET LOCAL splg.bypass_saldos = on` dentro de la transacción.
 *
 * El saldo del chofer (`delivery.balance`) no tiene libro: se ajusta a mano con
 * `PATCH /delivery/:id/balance`, así que no hay contra qué verificarlo.
 */
const SIN_BYPASS = `IF current_setting('splg.bypass_saldos', true) = 'on' THEN RETURN NULL; END IF;`;

const FUNCION_DE_CAJA = `CREATE FUNCTION verificar_saldo_de_caja() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE v_saldo numeric; v_libro numeric;
       BEGIN
         ${SIN_BYPASS}
         SELECT "balance" INTO v_saldo FROM "cash_box" WHERE "cash_box_id" = NEW."cash_box_id";
         IF NOT FOUND THEN RETURN NULL; END IF;
         SELECT coalesce(sum(CASE "direction" WHEN 'in' THEN "amount" ELSE -"amount" END), 0) INTO v_libro
           FROM "cash_movement" WHERE "cash_box_id" = NEW."cash_box_id";
         IF v_saldo <> v_libro THEN
           RAISE EXCEPTION 'El saldo de la caja (%) no coincide con la suma de sus movimientos (%)', v_saldo, v_libro
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_cash_box_saldo_contra_libro';
         END IF;
         RETURN NULL;
       END $$`;

const FUNCION_DE_CUENTA = `CREATE FUNCTION verificar_saldo_de_cuenta() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE v_saldo numeric; v_libro numeric;
       BEGIN
         ${SIN_BYPASS}
         SELECT "balance" INTO v_saldo FROM "customer_account" WHERE "account_id" = NEW."account_id";
         IF NOT FOUND THEN RETURN NULL; END IF;
         SELECT coalesce(sum(CASE WHEN "type" IN ('sale_charge', 'debit_note') THEN "amount" ELSE -"amount" END), 0) INTO v_libro
           FROM "customer_account_entry" WHERE "account_id" = NEW."account_id";
         IF v_saldo <> v_libro THEN
           RAISE EXCEPTION 'El saldo de la cuenta corriente (%) no coincide con la suma de sus asientos (%)', v_saldo, v_libro
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_customer_account_saldo_contra_libro';
         END IF;
         RETURN NULL;
       END $$`;

/** Existencia de una ubicación/garrafa/condición contra la suma de los movimientos que entran y salen. */
const FUNCION_DE_EXISTENCIA = `CREATE FUNCTION verificar_existencia_contra_libro(p_ubicacion uuid, p_garrafa uuid, p_condicion stock_condition_enum) RETURNS void LANGUAGE plpgsql AS $$
       DECLARE v_saldo bigint; v_libro bigint;
       BEGIN
         IF p_ubicacion IS NULL THEN RETURN; END IF;
         SELECT coalesce(sum("quantity"), 0) INTO v_saldo FROM "stock_balance"
           WHERE "location_id" = p_ubicacion AND "gas_cylinder_id" = p_garrafa AND "condition" = p_condicion;
         SELECT coalesce((SELECT sum("quantity") FROM "stock_movement"
                           WHERE "to_location_id" = p_ubicacion AND "gas_cylinder_id" = p_garrafa AND "to_condition" = p_condicion), 0)
              - coalesce((SELECT sum("quantity") FROM "stock_movement"
                           WHERE "from_location_id" = p_ubicacion AND "gas_cylinder_id" = p_garrafa AND "from_condition" = p_condicion), 0)
           INTO v_libro;
         IF v_saldo <> v_libro THEN
           RAISE EXCEPTION 'La existencia (%) no coincide con la suma de los movimientos de stock (%)', v_saldo, v_libro
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_stock_balance_saldo_contra_libro';
         END IF;
       END $$`;

const FUNCION_DE_EXISTENCIA_POR_SALDO = `CREATE FUNCTION verificar_existencia_del_saldo() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         ${SIN_BYPASS}
         PERFORM verificar_existencia_contra_libro(NEW."location_id", NEW."gas_cylinder_id", NEW."condition");
         RETURN NULL;
       END $$`;

const FUNCION_DE_EXISTENCIA_POR_MOVIMIENTO = `CREATE FUNCTION verificar_existencia_del_movimiento() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         ${SIN_BYPASS}
         PERFORM verificar_existencia_contra_libro(NEW."to_location_id", NEW."gas_cylinder_id", NEW."to_condition");
         PERFORM verificar_existencia_contra_libro(NEW."from_location_id", NEW."gas_cylinder_id", NEW."from_condition");
         RETURN NULL;
       END $$`;

const diferido = (
  nombre: string,
  evento: string,
  tabla: string,
  funcion: string,
) =>
  `CREATE CONSTRAINT TRIGGER "${nombre}" AFTER ${evento} ON "${tabla}"
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${funcion}()`;

/** Triggers (tabla, nombre) en el orden en que se crean. */
export const TRIGGERS_DE_SALDO: ReadonlyArray<{
  tabla: string;
  nombre: string;
}> = [
  { tabla: 'cash_box', nombre: 'TRG_cash_box_saldo_contra_libro' },
  { tabla: 'cash_movement', nombre: 'TRG_cash_movement_saldo_contra_libro' },
  {
    tabla: 'customer_account',
    nombre: 'TRG_customer_account_saldo_contra_libro',
  },
  {
    tabla: 'customer_account_entry',
    nombre: 'TRG_customer_account_entry_saldo_contra_libro',
  },
  { tabla: 'stock_balance', nombre: 'TRG_stock_balance_saldo_contra_libro' },
  { tabla: 'stock_movement', nombre: 'TRG_stock_movement_saldo_contra_libro' },
];

export const FUNCIONES_DE_SALDO = [
  'verificar_saldo_de_caja()',
  'verificar_saldo_de_cuenta()',
  'verificar_existencia_del_saldo()',
  'verificar_existencia_del_movimiento()',
  'verificar_existencia_contra_libro(uuid, uuid, stock_condition_enum)',
] as const;

/** Imputaciones de cuenta corriente: lo aplicado no puede pasar del importe del débito ni del crédito. */
const FUNCION_DE_IMPUTACION = `CREATE FUNCTION verificar_imputacion_de_cuenta() RETURNS trigger LANGUAGE plpgsql AS $$
       DECLARE v_asiento uuid; v_importe numeric; v_aplicado numeric;
       BEGIN
         ${SIN_BYPASS}
         FOREACH v_asiento IN ARRAY ARRAY[NEW."debit_entry_id", NEW."credit_entry_id"] LOOP
           SELECT "amount" INTO v_importe FROM "customer_account_entry" WHERE "entry_id" = v_asiento;
           SELECT coalesce(sum("amount"), 0) INTO v_aplicado FROM "customer_account_allocation"
             WHERE "debit_entry_id" = v_asiento OR "credit_entry_id" = v_asiento;
           IF v_aplicado > v_importe THEN
             RAISE EXCEPTION 'Lo imputado (%) supera el importe del asiento (%)', v_aplicado, v_importe
               USING ERRCODE = '23514', CONSTRAINT = 'CHK_customer_account_allocation_tope';
           END IF;
         END LOOP;
         RETURN NULL;
       END $$`;

export function sentenciasDeSaldos(): string[] {
  return [
    FUNCION_DE_CAJA,
    FUNCION_DE_CUENTA,
    FUNCION_DE_EXISTENCIA,
    FUNCION_DE_EXISTENCIA_POR_SALDO,
    FUNCION_DE_EXISTENCIA_POR_MOVIMIENTO,
    FUNCION_DE_IMPUTACION,
    diferido(
      'TRG_cash_box_saldo_contra_libro',
      'INSERT OR UPDATE OF "balance"',
      'cash_box',
      'verificar_saldo_de_caja',
    ),
    diferido(
      'TRG_cash_movement_saldo_contra_libro',
      'INSERT',
      'cash_movement',
      'verificar_saldo_de_caja',
    ),
    diferido(
      'TRG_customer_account_saldo_contra_libro',
      'INSERT OR UPDATE OF "balance"',
      'customer_account',
      'verificar_saldo_de_cuenta',
    ),
    diferido(
      'TRG_customer_account_entry_saldo_contra_libro',
      'INSERT',
      'customer_account_entry',
      'verificar_saldo_de_cuenta',
    ),
    diferido(
      'TRG_stock_balance_saldo_contra_libro',
      'INSERT OR UPDATE OF "quantity"',
      'stock_balance',
      'verificar_existencia_del_saldo',
    ),
    diferido(
      'TRG_stock_movement_saldo_contra_libro',
      'INSERT',
      'stock_movement',
      'verificar_existencia_del_movimiento',
    ),
    diferido(
      'TRG_customer_account_allocation_tope',
      'INSERT',
      'customer_account_allocation',
      'verificar_imputacion_de_cuenta',
    ),
  ];
}

export function sentenciasParaQuitarSaldos(): string[] {
  return [
    ...[
      ...TRIGGERS_DE_SALDO,
      {
        tabla: 'customer_account_allocation',
        nombre: 'TRG_customer_account_allocation_tope',
      },
    ].map((t) => `DROP TRIGGER IF EXISTS "${t.nombre}" ON "${t.tabla}"`),
    ...[...FUNCIONES_DE_SALDO, 'verificar_imputacion_de_cuenta()'].map(
      (f) => `DROP FUNCTION IF EXISTS ${f}`,
    ),
  ];
}
