import { ConflictException } from '@nestjs/common';
import { withTransactionRetry } from './with-transaction-retry';

const errorDePg = (code: string) => Object.assign(new Error(code), { code });

describe('withTransactionRetry', () => {
  const opciones = { baseDelayMs: 1 };

  it('reintenta una falla de serialización (40001) y devuelve el resultado', async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(errorDePg('40001'))
      .mockResolvedValue('ok');
    await expect(withTransactionRetry(fn, opciones)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each(['40001', '40P01'])(
    'agotados los 3 intentos por %s responde 409, no 500',
    async (codigo) => {
      const fn = jest.fn().mockRejectedValue(errorDePg(codigo));
      await expect(withTransactionRetry(fn, opciones)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(fn).toHaveBeenCalledTimes(3);
    },
  );

  it('un error que no es de concurrencia se propaga tal cual, sin reintento', async () => {
    const error = errorDePg('23505');
    const fn = jest.fn().mockRejectedValue(error);
    await expect(withTransactionRetry(fn, opciones)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
