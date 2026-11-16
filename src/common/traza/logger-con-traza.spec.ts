import { ContextoDeTraza } from './contexto-de-traza';
import { LoggerConTraza } from './logger-con-traza';

describe('LoggerConTraza', () => {
  let salida: string[];
  let escribir: jest.SpyInstance;

  beforeEach(() => {
    salida = [];
    escribir = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((texto: string | Uint8Array) => {
        salida.push(String(texto));
        return true;
      });
  });

  afterEach(() => escribir.mockRestore());

  it('dentro de una traza antepone [t:<8 primeros>] a la línea', () => {
    const logger = new LoggerConTraza('Prueba', { colors: false });
    ContextoDeTraza.abrir(
      { traceId: 'prueba-o1-mas-largo', origen: 'http' },
      () => logger.log('procesé 3 avisos'),
    );
    expect(salida.join('')).toContain('[Prueba] [t:prueba-o] procesé 3 avisos');
  });

  it('fuera de una traza la línea sale como siempre', () => {
    const logger = new LoggerConTraza('Prueba', { colors: false });
    logger.log('arranque');
    expect(salida.join('')).toContain('[Prueba] arranque');
    expect(salida.join('')).not.toContain('[t:');
  });

  it('en JSON agrega traceId', () => {
    const logger = new LoggerConTraza('Prueba', { json: true, colors: false });
    ContextoDeTraza.abrir({ traceId: 'prueba-o1', origen: 'cron' }, () =>
      logger.warn('ojo'),
    );
    const linea = JSON.parse(salida.join('').trim()) as Record<string, unknown>;
    expect(linea).toMatchObject({
      level: 'warn',
      message: 'ojo',
      context: 'Prueba',
      traceId: 'prueba-o1',
    });
  });

  it('en JSON sin traza no agrega el campo', () => {
    const logger = new LoggerConTraza('Prueba', { json: true, colors: false });
    logger.log('arranque');
    const linea = JSON.parse(salida.join('').trim()) as Record<string, unknown>;
    expect(linea).not.toHaveProperty('traceId');
  });
});
