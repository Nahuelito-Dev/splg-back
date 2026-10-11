import { enteroPositivoDeEnv } from './entero-positivo';

describe('enteroPositivoDeEnv', () => {
  const warn = jest.fn();
  const logger = { warn };
  beforeEach(() => jest.clearAllMocks());

  it('sin definir usa el default sin avisar', () => {
    expect(enteroPositivoDeEnv('X', undefined, 60000, logger)).toBe(60000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('un entero positivo (string o número) se respeta', () => {
    expect(enteroPositivoDeEnv('X', '1500', 60000, logger)).toBe(1500);
    expect(enteroPositivoDeEnv('X', 2500, 60000, logger)).toBe(2500);
  });

  it.each(['', '  ', 'abc', '0', '-5', '1.5', '1e3'])(
    '%j cae al default y avisa',
    (valor) => {
      expect(enteroPositivoDeEnv('X', valor, 60000, logger)).toBe(60000);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});
