/**
 * La distribuidora dejó de aceptar la transferencia como medio de pago: ningún
 * pedido ni invitación de recompra nuevos pueden quedar con ella. La regla se
 * valida en el back (`PAYMENT_METHOD_NOT_ACCEPTED`, 400) y acá en la base, para
 * lo que se escape del back.
 *
 * Son triggers y no un CHECK porque tienen que dejar pasar lo histórico: un
 * CHECK exige que TODAS las filas lo cumplan, y los pedidos viejos con
 * transferencia (que se siguen leyendo, listando, reportando y cobrando) no se
 * tocan. Sólo se rechaza el INSERT con transferencia o el UPDATE que PASA el
 * medio de otro valor a transferencia: editar otra columna de un pedido viejo
 * con transferencia, o dejarle la transferencia como estaba, sigue andando.
 *
 * Falla con SQLSTATE 23514 y la restricción indicada (`CHK_*`), que
 * `traducirErrorDeBase` traduce a 400 con el mensaje de `restricciones-de-base`.
 * Las crea la migración `SinTransferencia` y también el arranque de la base de
 * las pruebas de integración.
 *
 * Bypass para fixtures que necesitan sembrar un pedido histórico con
 * transferencia: `splg.bypass_transferencia = on` (el back nunca lo usa; las
 * pruebas de integración lo dejan encendido en la base descartable y lo apagan
 * con `SET LOCAL` para probar la regla).
 */
const BYPASS_TRANSFERENCIA = `IF current_setting('splg.bypass_transferencia', true) = 'on' THEN RETURN NEW; END IF;`;

const FUNCIONES = [
  `CREATE FUNCTION pedido_sin_transferencia() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         ${BYPASS_TRANSFERENCIA}
         IF NEW."paymentMethod"::text = 'transfer'
            AND (TG_OP = 'INSERT' OR OLD."paymentMethod"::text IS DISTINCT FROM 'transfer') THEN
           RAISE EXCEPTION 'La distribuidora ya no acepta transferencias: el pedido tiene que ser en efectivo o con Mercado Pago'
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_order_sin_transferencia';
         END IF;
         RETURN NEW;
       END $$`,
  `CREATE FUNCTION invitacion_de_recompra_sin_transferencia() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         ${BYPASS_TRANSFERENCIA}
         IF NEW."payment_method"::text = 'transfer'
            AND (TG_OP = 'INSERT' OR OLD."payment_method"::text IS DISTINCT FROM 'transfer') THEN
           RAISE EXCEPTION 'La distribuidora ya no acepta transferencias: la sugerencia de recompra tiene que ser en efectivo o con Mercado Pago'
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_repurchase_invitation_sin_transferencia';
         END IF;
         RETURN NEW;
       END $$`,
];

const TRIGGERS = [
  {
    nombre: 'TRG_order_sin_transferencia',
    tabla: 'order',
    columna: 'paymentMethod',
    funcion: 'pedido_sin_transferencia',
  },
  {
    nombre: 'TRG_repurchase_invitation_sin_transferencia',
    tabla: 'repurchase_invitation',
    columna: 'payment_method',
    funcion: 'invitacion_de_recompra_sin_transferencia',
  },
] as const;

export function sentenciasDeSinTransferencia(): string[] {
  return [
    ...FUNCIONES,
    ...TRIGGERS.map(
      (t) =>
        `CREATE TRIGGER "${t.nombre}" BEFORE INSERT OR UPDATE OF "${t.columna}" ON "${t.tabla}"
         FOR EACH ROW EXECUTE FUNCTION ${t.funcion}()`,
    ),
  ];
}

export function sentenciasParaQuitarSinTransferencia(): string[] {
  return [
    ...TRIGGERS.map(
      (t) => `DROP TRIGGER IF EXISTS "${t.nombre}" ON "${t.tabla}"`,
    ),
    ...TRIGGERS.map((t) => `DROP FUNCTION IF EXISTS ${t.funcion}()`),
  ];
}
