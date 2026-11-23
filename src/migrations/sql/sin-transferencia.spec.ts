import {
  sentenciasDeSinTransferencia,
  sentenciasParaQuitarSinTransferencia,
} from './sin-transferencia';

describe('Regla de base: sin transferencia', () => {
  const sql = sentenciasDeSinTransferencia().join('\n');

  it('crea un trigger BEFORE INSERT OR UPDATE OF por tabla, solo de columna del medio', () => {
    expect(sql).toContain(
      'CREATE TRIGGER "TRG_order_sin_transferencia" BEFORE INSERT OR UPDATE OF "paymentMethod" ON "order"',
    );
    expect(sql).toContain(
      'CREATE TRIGGER "TRG_repurchase_invitation_sin_transferencia" BEFORE INSERT OR UPDATE OF "payment_method" ON "repurchase_invitation"',
    );
    expect(sql).toContain('FOR EACH ROW');
  });

  it('rechaza el INSERT con transferencia y el UPDATE que pasa a transferencia', () => {
    expect(sql).toContain(`NEW."paymentMethod"::text = 'transfer'`);
    expect(sql).toContain(
      `(TG_OP = 'INSERT' OR OLD."paymentMethod"::text IS DISTINCT FROM 'transfer')`,
    );
    expect(sql).toContain(`NEW."payment_method"::text = 'transfer'`);
    expect(sql).toContain(
      `(TG_OP = 'INSERT' OR OLD."payment_method"::text IS DISTINCT FROM 'transfer')`,
    );
  });

  it('falla con 23514 y la restricción CHK_ que traduce el back', () => {
    expect(sql).toContain(`ERRCODE = '23514'`);
    expect(sql).toContain(`CONSTRAINT = 'CHK_order_sin_transferencia'`);
    expect(sql).toContain(
      `CONSTRAINT = 'CHK_repurchase_invitation_sin_transferencia'`,
    );
  });

  it('deja operar pedidos históricos: no dispara al cambiar estado, cobrar o cancelar', () => {
    // El trigger sólo se dispara por la columna del medio...
    expect(sql).not.toMatch(/BEFORE (INSERT OR )?UPDATE ON/);
    // ...y aun así, un UPDATE del medio que lo deja en transferencia como estaba pasa.
    expect(sql).not.toMatch(/RAISE EXCEPTION[^;]*\bWHEN\b/);
    expect(sql).not.toContain('DELETE');
    expect(sql).not.toMatch(/UPDATE "?order"? SET/);
  });

  it('el bypass es sólo para fixtures', () => {
    expect(sql).toContain(
      `current_setting('splg.bypass_transferencia', true) = 'on'`,
    );
  });

  it('el down quita triggers y funciones', () => {
    const down = sentenciasParaQuitarSinTransferencia().join('\n');
    expect(down).toContain(
      'DROP TRIGGER IF EXISTS "TRG_order_sin_transferencia"',
    );
    expect(down).toContain(
      'DROP FUNCTION IF EXISTS pedido_sin_transferencia()',
    );
  });
});
