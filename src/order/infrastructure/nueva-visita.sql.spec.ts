import {
  condicionEsperaNuevaVisita,
  sqlPedidoEsperaNuevaVisita,
} from './nueva-visita.sql';

describe('Retención de la nueva visita (C5) frente al despacho', () => {
  it('sólo un pendiente sin chofer con nueva visita: espera al admin, o a que empiece la franja del día (hora argentina)', () => {
    const sql = condicionEsperaNuevaVisita('o');
    expect(sql).toContain(`o."revisit_status" IS NOT NULL`);
    expect(sql).toContain(`o."status"::text = 'pending'`);
    expect(sql).toContain(`o."delivery_id" IS NULL`);
    expect(sql).toContain(`o."revisit_status" = 'awaiting_admin'`);
    expect(sql).toContain(`now() < ((o."scheduled_date" + COALESCE(`);
    expect(sql).toContain(`time '00:00'`);
    expect(sql).toContain(`AT TIME ZONE 'America/Argentina/Buenos_Aires'`);
  });

  it('para el pool arma la columna real del pedido (Order es palabra reservada)', () => {
    const sql = sqlPedidoEsperaNuevaVisita('Order.orderId');
    expect(sql).toContain(`onv."order_id" = "Order"."order_id"`);
    expect(sql).toContain(`onv."revisit_status" = 'awaiting_admin'`);
  });
});
