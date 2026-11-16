import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server, type Socket } from 'net';
import { EscanerClamAv, interpretarRespuestaDeClamAv } from './escaner-clamav';
import { escanerSegunLaConfiguracion } from './escaner.provider';
import { SinEscaneo } from './sin-escaneo';

/** La cadena de prueba EICAR: todos los antivirus la reconocen como «virus». */
const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Un `clamd` de mentira que habla INSTREAM de verdad: junta los trozos hasta
 * el de largo 0 y responde según el contenido.
 */
function clamdDePrueba(
  responder: (contenido: Buffer) => string | null,
): Promise<{ server: Server; port: number; recibido: () => Buffer[] }> {
  const recibidos: Buffer[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let comando = false;
    const trozos: Buffer[] = [];
    socket.on('data', (d: Buffer) => {
      buffer = Buffer.concat([buffer, d]);
      if (!comando) {
        const fin = buffer.indexOf(0);
        if (fin < 0) return;
        expect(buffer.subarray(0, fin).toString()).toBe('zINSTREAM');
        buffer = buffer.subarray(fin + 1);
        comando = true;
      }
      while (buffer.length >= 4) {
        const largo = buffer.readUInt32BE(0);
        if (largo === 0) {
          const contenido = Buffer.concat(trozos);
          recibidos.push(contenido);
          const respuesta = responder(contenido);
          if (respuesta !== null) socket.end(`${respuesta}\0`);
          return;
        }
        if (buffer.length < 4 + largo) return;
        trozos.push(buffer.subarray(4, 4 + largo));
        buffer = buffer.subarray(4 + largo);
      }
    });
  });
  return new Promise((resolver) =>
    server.listen(0, '127.0.0.1', () => {
      const dir = server.address();
      resolver({
        server,
        port: typeof dir === 'object' && dir ? dir.port : 0,
        recibido: () => recibidos,
      });
    }),
  );
}

describe('EscanerClamAv (INSTREAM por TCP)', () => {
  let srv: Awaited<ReturnType<typeof clamdDePrueba>>;
  beforeAll(async () => {
    srv = await clamdDePrueba((c) => {
      const t = c.toString();
      if (t.includes('EICAR')) return 'stream: Eicar-Test-Signature FOUND';
      if (t === 'cuelga') return null;
      if (t === 'rompe') return 'INSTREAM size limit exceeded. ERROR';
      return 'stream: OK';
    });
  });
  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  const escaner = (timeoutMs = 2000) =>
    new EscanerClamAv({ host: '127.0.0.1', port: srv.port, timeoutMs });

  it('un archivo limpio: OK, y llega entero aunque vaya en varios trozos', async () => {
    const grande = Buffer.alloc(200 * 1024, 7);
    await expect(escaner().escanear(grande)).resolves.toEqual({
      infectado: false,
    });
    expect(srv.recibido().at(-1)?.equals(grande)).toBe(true);
  });

  it('EICAR: infectado, con el nombre de la firma', async () => {
    await expect(escaner().escanear(Buffer.from(EICAR))).resolves.toEqual({
      infectado: true,
      firma: 'Eicar-Test-Signature',
    });
  });

  it('un error de clamd se lanza (quien escanea reintenta)', async () => {
    await expect(escaner().escanear(Buffer.from('rompe'))).rejects.toThrow(
      /no se entiende/,
    );
  });

  it('si no responde, corta por tiempo', async () => {
    await expect(escaner(200).escanear(Buffer.from('cuelga'))).rejects.toThrow(
      /no respondió/,
    );
  });

  it('sin servidor, el error de conexión se lanza', async () => {
    const cerrado = new EscanerClamAv({
      host: '127.0.0.1',
      port: 1,
      timeoutMs: 1000,
    });
    await expect(cerrado.escanear(Buffer.from('x'))).rejects.toThrow();
  });
});

describe('interpretarRespuestaDeClamAv', () => {
  it('OK, FOUND y lo demás', () => {
    expect(interpretarRespuestaDeClamAv('stream: OK\0')).toEqual({
      infectado: false,
    });
    expect(
      interpretarRespuestaDeClamAv('stream: Win.Test.EICAR_HDB-1 FOUND\0'),
    ).toEqual({ infectado: true, firma: 'Win.Test.EICAR_HDB-1' });
    expect(() => interpretarRespuestaDeClamAv('')).toThrow();
  });
});

describe('qué escáner se usa', () => {
  const config = (valores: Record<string, string | undefined>) =>
    ({ get: (k: string) => valores[k] }) as unknown as ConfigService;

  it('sin CLAMAV_HOST: sin escaneo (todo limpio)', async () => {
    const e = escanerSegunLaConfiguracion(config({ CLAMAV_HOST: '' }));
    expect(e).toBeInstanceOf(SinEscaneo);
    await expect(e.escanear(Buffer.from(EICAR))).resolves.toEqual({
      infectado: false,
    });
  });

  it('elegir sin escaneo deja un aviso en el log; apagado explícito gana sobre el host', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(escanerSegunLaConfiguracion(config({}))).toBeInstanceOf(SinEscaneo);
    expect(
      escanerSegunLaConfiguracion(
        config({ CLAMAV_HOST: 'clamav', CLAMAV_DISABLED: 'true' }),
      ),
    ).toBeInstanceOf(SinEscaneo);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain('CLAMAV_DISABLED');
    warn.mockRestore();
  });

  it('con CLAMAV_HOST: ClamAV', () => {
    expect(
      escanerSegunLaConfiguracion(
        config({ CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3310' }),
      ),
    ).toBeInstanceOf(EscanerClamAv);
  });
});
