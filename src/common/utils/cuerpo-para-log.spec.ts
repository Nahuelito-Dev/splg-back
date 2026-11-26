import { cuerpoParaLog, urlParaLog } from './cuerpo-para-log';

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

  it('enmascara por subcadena de la clave: idToken, refreshToken, apiKey y anidados', () => {
    const texto = cuerpoParaLog({
      idToken: 'eyJ.secreto.1',
      refreshToken: 'r-1',
      apiKey: 'k-1',
      newPassword: 'Nueva1234',
      Authorization: 'Bearer abc',
      cbu: '0000003100012345678901',
      datos: { clientSecret: 's-1', sesion: [{ accessToken: 'a-1' }] },
      orderDetails: 'sin cambios',
      notes: 'hola',
      quantity: 3,
    });
    for (const secreto of [
      'eyJ',
      'r-1',
      'k-1',
      'Nueva1234',
      'Bearer',
      '000000310',
      's-1',
      'a-1',
    ]) {
      expect(texto).not.toContain(secreto);
    }
    expect(JSON.parse(texto)).toEqual({
      idToken: '******',
      refreshToken: '******',
      apiKey: '******',
      newPassword: '******',
      Authorization: '******',
      cbu: '******',
      datos: { clientSecret: '******', sesion: [{ accessToken: '******' }] },
      orderDetails: 'sin cambios',
      notes: 'hola',
      quantity: 3,
    });
  });

  it('sin cuerpo devuelve {}', () => {
    expect(cuerpoParaLog(undefined)).toBe('{}');
    expect(cuerpoParaLog(null)).toBe('{}');
  });
  it('tapa las claves en castellano y el PIN, sin tocar lo que no es sensible', () => {
    const log = cuerpoParaLog({
      clave: 'secreta',
      contrasena: 'otra',
      contraseña: 'otra más',
      pin: '1234',
      shipping: 'ok',
    });
    expect(log).not.toContain('secreta');
    expect(log).not.toContain('otra');
    expect(log).not.toContain('1234');
    expect(log).toContain('"shipping":"ok"');
  });
});

describe('urlParaLog', () => {
  it('tapa los valores sensibles de la query y deja el resto', () => {
    const url = urlParaLog('/api/health?token=abc123&apiKey=xyz&page=2');
    expect(url).not.toContain('abc123');
    expect(url).not.toContain('xyz');
    expect(url).toContain('page=2');
    expect(url.startsWith('/api/health?')).toBe(true);
  });

  it('sin query la deja igual y sin URL devuelve un guion', () => {
    expect(urlParaLog('/api/orders/1')).toBe('/api/orders/1');
    expect(urlParaLog(undefined)).toBe('-');
  });
});
