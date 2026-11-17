import {
  esClaveSensible,
  FILTRADO,
  limpiarUrl,
  limpiarValor,
  taparEnTexto,
} from './datos-sensibles';

describe('datos sensibles para Sentry', () => {
  it.each([
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'x-support-session',
    'password',
    'newPassword',
    'contraseña',
    'token',
    'idToken',
    'access_token',
    'refreshToken',
    'dni',
    'dniFrente',
    'cuit',
    'cuil',
    'phone',
    'telefono',
    'phones',
    'email',
    'customerEmail',
    'emails',
    'address',
    'direccion',
    'direcciones',
    'domicilio',
    'mpAccessToken',
    'AWS_SECRET_ACCESS_KEY',
    'accessKeyId',
    'client_secret',
    'private_key',
    'apiKey',
    'x-signature',
    'credentials',
    'client.address',
  ])('«%s» es sensible', (clave) => {
    expect(esClaveSensible(clave)).toBe(true);
  });

  it.each([
    'id',
    'user_id',
    'status',
    'circuit_open',
    'ordinal',
    'distributor_id',
    'quantity',
    'requestId',
    'server.address',
    'sentry.release',
  ])('«%s» no es sensible', (clave) => {
    expect(esClaveSensible(clave)).toBe(false);
  });

  it('tapa los campos sensibles en cualquier nivel y no toca el original', () => {
    const original = {
      id: 'pedido-1',
      quantity: 2,
      customer: {
        name: 'Ana',
        email: 'ana@example.com',
        dni: '30111222',
        addresses: [{ address: 'Calle 1', city: 'Posadas' }],
      },
      payment: { mpAccessToken: 'APP_USR-123', amount: '100.00' },
    };
    const limpio = limpiarValor(original);
    expect(limpio).toEqual({
      id: 'pedido-1',
      quantity: 2,
      customer: {
        name: 'Ana',
        email: FILTRADO,
        dni: FILTRADO,
        addresses: FILTRADO,
      },
      payment: { mpAccessToken: FILTRADO, amount: '100.00' },
    });
    expect(original.customer.email).toBe('ana@example.com');
  });

  it('tapa correos, JWT y Bearer dentro de textos libres', () => {
    expect(
      taparEnTexto(
        'falló ana.perez+x@example.com.ar con Bearer abc.def-123 y eyJhbGciOi.eyJzdWIi.firma_1',
      ),
    ).toBe(`falló ${FILTRADO} con Bearer ${FILTRADO} y ${FILTRADO}`);
    expect(limpiarValor(['ver a@b.co', 3, null])).toEqual([
      `ver ${FILTRADO}`,
      3,
      null,
    ]);
  });

  it('un release (`nombre@versión`) no es un correo', () => {
    expect(taparEnTexto('splg-server@2.1.0')).toBe('splg-server@2.1.0');
    expect(taparEnTexto('ANA@Example.COM')).toBe(FILTRADO);
  });

  it('corta los ciclos y la profundidad', () => {
    const ciclico: Record<string, unknown> = { id: 1 };
    ciclico.yo = ciclico;
    expect(limpiarValor(ciclico)).toEqual({ id: 1, yo: '[Circular]' });

    let profundo: Record<string, unknown> = { fin: true };
    for (let i = 0; i < 15; i += 1) profundo = { nivel: profundo };
    expect(JSON.stringify(limpiarValor(profundo))).toContain('[Truncated]');
  });

  it('deja las instancias de clases como están', () => {
    const fecha = new Date(0);
    expect(limpiarValor({ cuando: fecha })).toEqual({ cuando: fecha });
  });

  it('una URL sale sin la consulta ni el fragmento', () => {
    expect(limpiarUrl('/api/v1/users?email=a%40b.co&page=2')).toBe(
      '/api/v1/users',
    );
    expect(limpiarUrl('https://api.splg.com/x?token=abc#frag')).toBe(
      'https://api.splg.com/x',
    );
    expect(limpiarUrl('api/v1/users?dni=301')).toBe('api/v1/users');
    expect(limpiarUrl('/api/v1/users/a@b.co')).toBe(
      `/api/v1/users/${FILTRADO}`,
    );
  });

  it('las URLs dentro de un texto pierden la consulta', () => {
    expect(
      taparEnTexto(
        '[req-1] GET /api/v1/customers?dni=301&page=2 500 — falló https://api.mercadopago.com/v1/payments?access_token=APP_USR-1 ok',
      ),
    ).toBe(
      '[req-1] GET /api/v1/customers 500 — falló https://api.mercadopago.com/v1/payments ok',
    );
    expect(taparEnTexto('¿Seguro? 10/11 a las 9')).toBe(
      '¿Seguro? 10/11 a las 9',
    );
  });

  it('tapa los valores del detail de Postgres', () => {
    // El caso del proveedor: CUIT repetido.
    expect(
      taparEnTexto(
        'Regla de la base violada: Key (distributor_id, tax_id)=(d1f1-0000, 20-30111222-3) already exists.',
      ),
    ).toBe(
      `Regla de la base violada: Key (distributor_id, tax_id)=(${FILTRADO}) already exists.`,
    );
    expect(
      taparEnTexto(
        'Exclusión violada: Key (car_id, period)=(c-1, [2026-01-01,2026-02-01)) conflicts with existing key (car_id, period)=(c-1, [2026-01-15,2026-03-01)).',
      ),
    ).toBe(
      `Exclusión violada: Key (car_id, period)=(${FILTRADO}) conflicts with existing key (car_id, period)=(${FILTRADO}).`,
    );
    expect(
      taparEnTexto(
        'Clave foránea violada: Key (supplier_id)=(abc) is not present in table "supplier".',
      ),
    ).toBe(
      `Clave foránea violada: Key (supplier_id)=(${FILTRADO}) is not present in table "supplier".`,
    );
    expect(
      taparEnTexto(
        'new row violates check constraint "CHK_x". Failing row contains (1, Ana, 30111222, 3764000000).',
      ),
    ).toBe(
      `new row violates check constraint "CHK_x". Failing row contains (${FILTRADO}).`,
    );
  });
});
