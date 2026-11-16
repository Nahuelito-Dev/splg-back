import { Audit } from '../entities/audit.entity';
import { DataAuditMapper } from './data-audit.mapper';

const fila = (p: Partial<Audit>) =>
  Object.assign(new Audit(), {
    auditId: 'a1',
    actionTypeId: 2,
    userId: null,
    distributorId: null,
    entity: 'Car',
    recordId: 'c1',
    ip: null,
    source: 'db',
    tableName: 'car',
    dbUser: 'postgres',
    appName: 'splg-api',
    createdAt: new Date(),
    ...p,
  });

describe('DataAuditMapper: origen del asiento', () => {
  it('con usuario es user', () => {
    expect(DataAuditMapper.origenDe(fila({ userId: 'u1' }))).toBe('user');
  });

  it('sin usuario y desde la API es system', () => {
    expect(DataAuditMapper.origenDe(fila({}))).toBe('system');
  });

  it('sin usuario y desde otra aplicación (psql, un script) es direct', () => {
    expect(DataAuditMapper.origenDe(fila({ appName: 'psql' }))).toBe('direct');
    expect(
      DataAuditMapper.origenDe(fila({ appName: 'splg-script:seed-demo' })),
    ).toBe('direct');
    expect(DataAuditMapper.origenDe(fila({ appName: null }))).toBe('direct');
  });

  it('lo asentado por la API (source app) o anterior a la marca es system', () => {
    expect(
      DataAuditMapper.origenDe(fila({ source: 'app', appName: null })),
    ).toBe('system');
  });

  it('la v2 agrega origen y las columnas nuevas a la v1', () => {
    const dto = DataAuditMapper.toDtoV2(fila({ appName: 'psql' }), []);
    expect(dto).toMatchObject({
      origin: 'direct',
      source: 'db',
      tableName: 'car',
      dbUser: 'postgres',
      appName: 'psql',
      entity: 'Car',
    });
    expect(DataAuditMapper.toDto(fila({}), [])).not.toHaveProperty('origin');
  });
});
