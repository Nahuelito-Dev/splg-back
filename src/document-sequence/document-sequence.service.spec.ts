import { EntityManager } from 'typeorm';
import { DocType, DocumentSequenceService } from './document-sequence.service';

const managerCon = (transaccionActiva: boolean) =>
  ({
    queryRunner: { isTransactionActive: transaccionActiva },
    query: jest.fn().mockResolvedValue([{ last_number: 7 }]),
  }) as unknown as EntityManager & { query: jest.Mock };

describe('DocumentSequenceService', () => {
  const service = new DocumentSequenceService();

  it('devuelve el número que informa la base dentro de una transacción', async () => {
    const manager = managerCon(true);
    await expect(
      service.siguienteNumero(manager, 'dist-1', DocType.PURCHASE_ORDER),
    ).resolves.toBe(7);
    expect(manager.query).toHaveBeenCalledWith(expect.any(String), [
      'dist-1',
      'purchase_order',
    ]);
  });

  it('sin transacción activa es un error de programación y no consulta', async () => {
    const manager = managerCon(false);
    await expect(
      service.siguienteNumero(manager, 'dist-1', DocType.TRUCK_LOAD),
    ).rejects.toThrow(/dentro de la transacción/);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it.each(['', 'Orden', 'con espacio', "x'; DROP", 'a'.repeat(41)])(
    'rechaza el tipo de documento inválido %p',
    async (docType) => {
      const manager = managerCon(true);
      await expect(
        service.siguienteNumero(manager, 'dist-1', docType),
      ).rejects.toThrow(/Tipo de documento inválido/);
      expect(manager.query).not.toHaveBeenCalled();
    },
  );

  it('acepta el largo máximo de la columna', async () => {
    await expect(
      service.siguienteNumero(managerCon(true), 'dist-1', 'a'.repeat(40)),
    ).resolves.toBe(7);
  });
});
