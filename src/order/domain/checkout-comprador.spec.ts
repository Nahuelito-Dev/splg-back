import { datosDelComprador } from './checkout-comprador';

describe('datosDelComprador', () => {
  const comprador = {
    email: 'ana@test.com',
    fullName: 'Ana Pérez',
    phoneNumber: '+5493815550003',
  };
  const direccion = {
    street: 'Bolívar 1617',
    city: 'Posadas',
    postalCode: '3300',
    floor: '2',
    apartment: 'B',
  };

  it('arma el pagador y la dirección de entrega con lo que hay', () => {
    expect(datosDelComprador(comprador, direccion)).toEqual({
      payer: {
        email: 'ana@test.com',
        fullName: 'Ana Pérez',
        phone: '+5493815550003',
        address: { street: 'Bolívar 1617', zipCode: '3300' },
      },
      receiverAddress: {
        street: 'Bolívar 1617',
        city: 'Posadas',
        zipCode: '3300',
        floor: '2',
        apartment: 'B',
      },
    });
  });

  it('no inventa el documento del comprador', () => {
    expect(datosDelComprador(comprador, direccion).payer.document).toBe(
      undefined,
    );
  });
});
