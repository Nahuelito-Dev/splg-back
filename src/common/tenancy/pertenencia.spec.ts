import {
  clienteDeLaDistribuidora,
  usuarioDeLaDistribuidora,
} from './pertenencia';

describe('pertenencia a una distribuidora', () => {
  it('un cliente es de la distribuidora si le compró o si ella lo dio de alta', () => {
    const sql = clienteDeLaDistribuidora('c.userId');
    expect(sql).toContain('FROM "order"');
    expect(sql).toContain('FROM customer_distributor');
    expect(sql).toMatch(/\) OR EXISTS/);
  });

  it('un vínculo dado de baja excluye al cliente aunque tenga pedidos', () => {
    const sql = clienteDeLaDistribuidora('c.userId');
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM customer_distributor/);
    expect(sql).toContain('removed_at IS NOT NULL');
    expect(sql.match(/:distributorId/g)).toHaveLength(3);
  });

  it('el usuario de la distribuidora incluye al cliente dado de alta', () => {
    expect(usuarioDeLaDistribuidora('u.userId')).toContain(
      'FROM customer_distributor',
    );
  });

  it('respeta el nombre del parámetro', () => {
    expect(clienteDeLaDistribuidora('c.userId', 'tenant')).not.toContain(
      ':distributorId',
    );
  });
});
