import { cuerpoParaLog } from './cuerpo-para-log';

describe('cuerpoParaLog', () => {
  it('enmascara credenciales y los datos de quien recibe, también anidados', () => {
    const texto = cuerpoParaLog({
      password: 'x',
      notes: 'hola',
      receiverName: 'María Gómez',
      receiverDocument: '30123456',
      receiverRelationship: 'vecina',
      receiver: { receiverDocument: '30123456', receiverName: 'María' },
      lista: [{ Token: 't' }],
    });
    expect(texto).not.toContain('30123456');
    expect(texto).not.toContain('María');
    expect(texto).not.toContain('vecina');
    expect(JSON.parse(texto)).toMatchObject({
      password: '******',
      notes: 'hola',
      receiverDocument: '******',
      receiver: { receiverDocument: '******' },
      lista: [{ Token: '******' }],
    });
  });

  it('sin cuerpo devuelve {}', () => {
    expect(cuerpoParaLog(undefined)).toBe('{}');
    expect(cuerpoParaLog(null)).toBe('{}');
  });
});
