import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CustomersService } from './customer.service';
import { Customer } from './entities/customer.entity';

/**
 * Lo que protege el servicio de clientes es la propiedad del dato: un cliente
 * sólo ve y toca lo suyo; un administrador pasa sin requesterUserId.
 */
describe('CustomersService', () => {
  let service: CustomersService;
  let customers: {
    findOne: jest.Mock;
    save: jest.Mock;
    softDelete: jest.Mock;
    preload: jest.Mock;
  };

  const cliente = (over: Partial<Customer> = {}): Customer =>
    ({
      customerId: 'c1',
      userId: 'u1',
      ...over,
    }) as Customer;

  beforeEach(() => {
    customers = {
      findOne: jest.fn(),
      save: jest.fn((c: Customer) => Promise.resolve(c)),
      softDelete: jest.fn(),
      preload: jest.fn(),
    };
    service = new CustomersService(
      customers as unknown as Repository<Customer>,
    );
  });

  it('un cliente inexistente es 404', async () => {
    customers.findOne.mockResolvedValue(null);
    await expect(service.findOne('c9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('un cliente no puede ver el perfil de otro', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(service.findOne('c1', 'otro')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('el dueño y el administrador sí lo ven', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(service.findOne('c1', 'u1')).resolves.toMatchObject({
      customerId: 'c1',
    });
    await expect(service.findOne('c1')).resolves.toMatchObject({
      customerId: 'c1',
    });
  });

  it('por usuario, el control de propiedad corre antes de consultar', async () => {
    await expect(service.findOneByUserId('u1', 'otro')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(customers.findOne).not.toHaveBeenCalled();
  });

  it('la posición de otro cliente no se puede mover', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(
      service.updateLocation('c1', '-27.1,-55.1', 'otro'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(customers.save).not.toHaveBeenCalled();
  });

  it('la baja es lógica y responde con un mensaje', async () => {
    customers.findOne.mockResolvedValue(cliente());
    await expect(service.remove('c1')).resolves.toEqual({
      message: 'Customer deleted successfully',
    });
    expect(customers.softDelete).toHaveBeenCalledWith({ customerId: 'c1' });
  });
});
