import {
  claveDeSalida,
  desgloseDelEfectivo,
  efectivoACobrar,
  efectivoDelPedido,
  esMontoRedondo,
  montoEnPesos,
  textoDelEfectivoAlConfirmar,
  textoDelEfectivoAlSalir,
} from './efectivo-a-cobrar';

const base = {
  paymentMethod: 'cash',
  paymentStatus: 'pending',
  status: 'accepted',
  total: 22600,
  depositAmount: 0,
  depositPaid: false,
};

describe('efectivoACobrar', () => {
  it('es el total de un pedido en efectivo sin cobrar', () => {
    expect(efectivoACobrar(base)).toBe(22600);
  });

  it('descuenta la seña si ya está paga', () => {
    expect(
      efectivoACobrar({ ...base, depositAmount: 5000, depositPaid: true }),
    ).toBe(17600);
  });

  it('en una reserva descuenta la seña comprometida aunque no esté confirmada', () => {
    const reserva = {
      ...base,
      status: 'reserved',
      depositAmount: 5000,
      depositPaid: false,
    };
    expect(desgloseDelEfectivo(reserva)).toEqual({
      monto: 17600,
      senaDescontada: 5000,
    });
  });

  it('fuera de la reserva, una seña sin pagar no se descuenta', () => {
    expect(
      efectivoACobrar({ ...base, depositAmount: 5000, depositPaid: false }),
    ).toBe(22600);
  });

  it.each([
    ['otro medio de pago', { paymentMethod: 'mercadopago' }],
    ['ya cobrado', { paymentStatus: 'paid' }],
    ['impago informado', { paymentStatus: 'unpaid' }],
    ['entregado', { status: 'delivered' }],
    ['cancelado', { status: 'cancelled' }],
    ['seña que cubre todo', { depositAmount: 22600, depositPaid: true }],
  ])('es null si %s', (_caso, cambio) => {
    expect(efectivoACobrar({ ...base, ...cambio })).toBeNull();
  });

  it('se ofrece en la oferta (pedido pendiente) y en camino', () => {
    expect(efectivoACobrar({ ...base, status: 'pending' })).toBe(22600);
    expect(efectivoACobrar({ ...base, status: 'on_the_way' })).toBe(22600);
  });

  it('sobre la entidad acepta importes como texto y señas ausentes', () => {
    expect(
      efectivoDelPedido({
        paymentMethod: 'cash',
        paymentStatus: 'pending',
        status: 'accepted',
        totalAmount: '10500.50',
        depositAmount: null,
        depositPaid: undefined,
      }),
    ).toBe(10500.5);
  });
});

describe('textos del efectivo', () => {
  it('el monto sale con puntos de miles y centavos sólo si hacen falta', () => {
    expect(montoEnPesos(12500)).toBe('$12.500');
    expect(montoEnPesos(12500.5)).toBe('$12.500,50');
  });

  it('redondo es de pesos enteros y múltiplo de 100', () => {
    expect(esMontoRedondo(12500)).toBe(true);
    expect(esMontoRedondo(12550)).toBe(false);
    expect(esMontoRedondo(12500.5)).toBe(false);
  });

  it('al confirmar dice cuánto se paga al recibirlo', () => {
    expect(textoDelEfectivoAlConfirmar(12500)).toBe(
      'Pagás $12.500 en efectivo cuando te lo entreguen.',
    );
  });

  it('al confirmar una reserva dice que la seña ya está descontada', () => {
    expect(textoDelEfectivoAlConfirmar(17600, 5000)).toBe(
      'Pagás $17.600 en efectivo cuando te lo entreguen (ya descontada la seña de $5.000).',
    );
  });

  it('la salida cambia con el chofer y con los intentos fallidos', () => {
    expect(claveDeSalida('d1', 0)).toBe('d1:0');
    expect(claveDeSalida('d1', 1)).not.toBe(claveDeSalida('d1', 0));
    expect(claveDeSalida(null, undefined)).toBe('sin-chofer:0');
  });

  it('al salir sugiere el monto exacto sólo si no es redondo', () => {
    expect(textoDelEfectivoAlSalir(12500)).toBe(
      'Tené listos $12.500 en efectivo.',
    );
    expect(textoDelEfectivoAlSalir(12550)).toContain('monto exacto');
  });
});
