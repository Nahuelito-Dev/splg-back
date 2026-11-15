import { DataSource } from 'typeorm';
import { DISTRIBUIDORA_SIN_NOMBRE } from './layout/marca-de-correo';
import { MarcasDeCorreo } from './marcas-de-correo.service';

describe('MarcasDeCorreo', () => {
  const armar = (findOne: jest.Mock) =>
    new MarcasDeCorreo({
      getRepository: () => ({ findOne }),
    } as unknown as DataSource);

  it('lee el nombre de la distribuidora (también dada de baja)', async () => {
    const findOne = jest.fn().mockResolvedValue({ name: 'Gas del Sur' });
    const marca = await armar(findOne).deDistribuidora('d1');
    expect(marca.tipo).toBe('distribuidora');
    expect(marca.nombre).toBe('Gas del Sur');
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { distributorId: 'd1' },
        withDeleted: true,
      }),
    );
  });

  it('si no existe, el encabezado genérico', async () => {
    const marca = await armar(
      jest.fn().mockResolvedValue(null),
    ).deDistribuidora('d1');
    expect(marca.nombre).toBe(DISTRIBUIDORA_SIN_NOMBRE);
  });

  it('si la base falla, el correo sale igual con el genérico', async () => {
    const marca = await armar(
      jest.fn().mockRejectedValue(new Error('db caída')),
    ).deDistribuidora('d1');
    expect(marca.nombre).toBe(DISTRIBUIDORA_SIN_NOMBRE);
  });
});
