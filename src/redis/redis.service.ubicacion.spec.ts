import { RedisService } from './redis.service';

describe('RedisService · última ubicación del chofer', () => {
  let client: {
    geoadd: jest.Mock;
    setex: jest.Mock;
    geopos: jest.Mock;
    get: jest.Mock;
    zrem: jest.Mock;
    del: jest.Mock;
  };
  let service: RedisService;

  beforeEach(() => {
    client = {
      geoadd: jest.fn().mockResolvedValue(1),
      setex: jest.fn().mockResolvedValue('OK'),
      geopos: jest.fn(),
      get: jest.fn(),
      zrem: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };
    service = Object.assign(Object.create(RedisService.prototype), {
      client,
    }) as RedisService;
  });

  it('al reportar la posición anota también cuándo (24 h)', async () => {
    await service.updateDriverLocation('u1', -34.6, -58.4);
    expect(client.geoadd).toHaveBeenCalledWith(
      'drivers:locations',
      -58.4,
      -34.6,
      'u1',
    );
    const [clave, ttl, hora] = client.setex.mock.calls[0] as [
      string,
      number,
      string,
    ];
    expect(clave).toBe('driver:location-at:u1');
    expect(ttl).toBe(24 * 60 * 60);
    expect(new Date(hora).toISOString()).toBe(hora);
  });

  it('devuelve lat, lng y la hora anotada', async () => {
    client.geopos.mockResolvedValue([['-58.4012', '-34.6101']]);
    client.get.mockResolvedValue('2026-10-12T20:15:00.000Z');
    await expect(service.getDriverLastLocation('u1')).resolves.toEqual({
      lat: -34.6101,
      lng: -58.4012,
      at: '2026-10-12T20:15:00.000Z',
    });
    expect(client.get).toHaveBeenCalledWith('driver:location-at:u1');
  });

  it('una posición sin hora anotada devuelve at null', async () => {
    client.geopos.mockResolvedValue([['-58.4', '-34.6']]);
    client.get.mockResolvedValue(null);
    await expect(service.getDriverLastLocation('u1')).resolves.toMatchObject({
      at: null,
    });
  });

  it('un chofer fuera del radar devuelve null', async () => {
    client.geopos.mockResolvedValue([null]);
    await expect(service.getDriverLastLocation('u1')).resolves.toBeNull();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('sacarlo del radar borra también la hora', async () => {
    await service.removeDriver('u1');
    expect(client.zrem).toHaveBeenCalledWith('drivers:locations', 'u1');
    expect(client.del).toHaveBeenCalledWith('driver:location-at:u1');
  });

  describe('withLock', () => {
    let using: jest.Mock;
    beforeEach(() => {
      using = jest.fn();
      Object.assign(service, {
        redlock: { using },
        logger: { warn: jest.fn() },
      });
    });
    const conLock = (liberarFalla?: Error) =>
      using.mockImplementation(
        async (_k: string[], _t: number, fn: () => Promise<unknown>) => {
          await fn();
          if (liberarFalla) throw liberarFalla;
        },
      );

    it('devuelve el resultado de la operación', async () => {
      conLock();
      await expect(
        service.withLock('k', 1000, () => Promise.resolve(7)),
      ).resolves.toEqual({
        obtenido: true,
        valor: 7,
      });
    });

    it('un error al soltar o renovar el lock NO tira abajo una operación ya hecha', async () => {
      conLock(new Error('lock expirado'));
      await expect(
        service.withLock('k', 1000, () => Promise.resolve(7)),
      ).resolves.toEqual({
        obtenido: true,
        valor: 7,
      });
    });

    it('un error de la operación se propaga igual', async () => {
      conLock();
      await expect(
        service.withLock('k', 1000, () => Promise.reject(new Error('falla'))),
      ).rejects.toThrow('falla');
    });

    it('sin lock (otro lo tiene) no ejecuta y lo informa', async () => {
      using.mockRejectedValue(new Error('ya tomado'));
      const fn = jest.fn();
      await expect(service.withLock('k', 1000, fn)).resolves.toEqual({
        obtenido: false,
      });
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
