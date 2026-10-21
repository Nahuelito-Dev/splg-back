import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';
import { QuoteOrderDto } from './quote-order.dto';

const G = 'c0b2f6d2-1b6c-4a43-9d5b-0a6e5c1f7a10';
const base = {
  customerId: G,
  addressId: G,
  paymentMethod: 'cash',
};

const mensajes = async (clase: new () => object, cuerpo: object) =>
  (await validate(plainToInstance(clase, cuerpo))).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );

describe('items vacíos', () => {
  it('el alta rechaza items: [] (un pedido sin renglones)', async () => {
    expect(await mensajes(CreateOrderDto, { ...base, items: [] })).toContain(
      'El pedido necesita al menos un renglón',
    );
  });

  it('el checkout del carrito no manda items y sigue siendo válido', async () => {
    expect(await mensajes(CreateOrderDto, { ...base, fromCart: true })).toEqual(
      [],
    );
  });
});

describe('items repetidos', () => {
  const repetidos = [
    { gasCylinderId: G, quantity: 1, unitPrice: 1 },
    { gasCylinderId: G, quantity: 2, unitPrice: 1 },
  ];

  it.each([
    ['el alta', CreateOrderDto],
    ['la cotización', QuoteOrderDto],
  ])('%s rechaza la misma garrafa en dos renglones', async (_n, clase) => {
    expect(await mensajes(clase, { ...base, items: repetidos })).toContain(
      'items no puede repetir la misma garrafa: sumá las cantidades en un solo renglón',
    );
  });

  it('garrafas distintas pasan', async () => {
    expect(
      await mensajes(CreateOrderDto, {
        ...base,
        items: [
          { gasCylinderId: G, quantity: 1, unitPrice: 1 },
          {
            gasCylinderId: 'd0b2f6d2-1b6c-4a43-9d5b-0a6e5c1f7a11',
            quantity: 1,
            unitPrice: 1,
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe('depositAmount', () => {
  const reserva = {
    ...base,
    fromCart: true,
    isReservation: true,
    scheduledDate: '2030-01-01',
  };

  it.each([
    ['el alta', CreateOrderDto],
    ['la cotización', QuoteOrderDto],
  ])('%s rechaza una seña con más de 2 decimales', async (_n, clase) => {
    expect(
      await mensajes(clase, { ...reserva, depositAmount: 0.001 }),
    ).toContain(
      'depositAmount must be a number conforming to the specified constraints',
    );
  });

  it('acepta una seña de 2 decimales', async () => {
    expect(
      await mensajes(CreateOrderDto, { ...reserva, depositAmount: 100.25 }),
    ).toEqual([]);
  });
});
