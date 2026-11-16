import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { EmployeePhotoService } from './employee-photo.service';
import type { EmployeeService } from './employee.service';
import type { Employee } from './entities/employee.entity';
import type { EntityPhotoService } from '../s3/entity-photo.service';

describe('EmployeePhotoService', () => {
  let employees: { findOne: jest.Mock };
  let fotos: {
    guardar: jest.Mock;
    quitar: jest.Mock;
    firmar: jest.Mock;
    enlace: jest.Mock;
  };
  let usuarios: { find: jest.Mock; findOne: jest.Mock };
  let servicio: EmployeePhotoService;

  beforeEach(() => {
    employees = { findOne: jest.fn() };
    fotos = {
      guardar: jest.fn().mockResolvedValue(undefined),
      quitar: jest.fn().mockResolvedValue(undefined),
      firmar: jest.fn().mockResolvedValue(undefined),
      enlace: jest.fn().mockResolvedValue({ kind: 'none' }),
    };
    usuarios = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({ photoKey: 'users/u1/a.png' }),
    };
    servicio = new EmployeePhotoService(
      employees as unknown as EmployeeService,
      { getRepository: () => usuarios } as unknown as DataSource,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('un legajo sin cuenta guarda su propia foto en la carpeta de la distribuidora', async () => {
    employees.findOne.mockResolvedValue({ employeeId: 'e1', userId: null });
    await servicio.subir('e1', 'd1', undefined);
    expect(fotos.guardar).toHaveBeenCalledWith(
      expect.objectContaining({ keyProp: 'photoKey' }),
      'e1',
      undefined,
      'employees/d1/e1',
      expect.any(Function),
    );
  });

  it('el control que corre con el legajo bloqueado rechaza uno que ya tiene cuenta', async () => {
    employees.findOne.mockResolvedValue({ employeeId: 'e1', userId: null });
    await servicio.subir('e1', 'd1', undefined);
    const verificar = (fotos.guardar.mock.calls[0] as unknown[])[4] as (
      fila: Record<string, unknown>,
    ) => void;
    expect(() => verificar({ userId: null })).not.toThrow();
    expect(() => verificar({ userId: 'u1' })).toThrow(ConflictException);
  });

  it('con cuenta de acceso, subir y quitar dan 409: la foto es la del usuario', async () => {
    employees.findOne.mockResolvedValue({ employeeId: 'e1', userId: 'u1' });
    await expect(servicio.subir('e1', 'd1', undefined)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(servicio.quitar('e1', 'd1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fotos.guardar).not.toHaveBeenCalled();
    expect(fotos.quitar).not.toHaveBeenCalled();
  });

  it('firmar usa la key del usuario si el legajo tiene cuenta, y la propia si no', async () => {
    usuarios.find.mockResolvedValue([
      { userId: 'u1', photoKey: 'users/u1/a.png' },
    ]);
    const conCuenta = {
      userId: 'u1',
      photoKey: 'employees/d1/e1/propia.png',
    } as Employee;
    const sinCuenta = {
      userId: null,
      photoKey: 'employees/d1/e2/b.png',
    } as Employee;
    await servicio.firmar([conCuenta, sinCuenta]);
    const claveDe = (
      fotos.firmar.mock.calls[0] as [Employee[], (e: Employee) => string | null]
    )[1];
    expect(claveDe(conCuenta)).toBe('users/u1/a.png');
    expect(claveDe(sinCuenta)).toBe('employees/d1/e2/b.png');
  });

  it('el enlace de un legajo con cuenta es el de la foto del usuario', async () => {
    employees.findOne.mockResolvedValue({ employeeId: 'e1', userId: 'u1' });
    await servicio.enlace('e1', 'd1');
    expect(fotos.enlace).toHaveBeenCalledWith('users/u1/a.png');
  });
});
