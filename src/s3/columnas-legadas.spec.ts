import { ClaimMapper } from '../claims/claims.mapper';
import { Claim } from '../claims/entities/claim.entity';
import { Distributor } from '../distributor/entities/distributor.entity';
import { DistributorMapper } from '../distributor/distributor.mapper';
import { Incident } from '../incident/entities/incident.entity';
import { IncidentMapper } from '../incident/incident.mapper';
import { User } from '../users/entities/user.entity';
import { UserMapper } from '../users/user.mapper';

const EXTERNA = 'https://externa.example/foto.jpg';

/**
 * Las columnas de texto anteriores a S3 (`photoUrl`, `photo_url`, `logo_url`,
 * `selfie`) no se exponen: las respuestas llevan sólo la URL firmada.
 */
describe('columnas legadas de foto: no salen en las respuestas', () => {
  it('reclamo', () => {
    const claim = {
      photoUrl: EXTERNA,
      createdAt: new Date(),
      order: { orderId: 'o1' },
    } as unknown as Claim;
    expect(ClaimMapper.toDto(claim).photoUrl).toBeNull();
    expect(ClaimMapper.toMyDto(claim).photoUrl).toBeNull();
    expect(ClaimMapper.toDto(claim, 'https://s3/firmada').photoUrl).toBe(
      'https://s3/firmada',
    );
  });

  it('incidencia', () => {
    const i = { photoUrl: EXTERNA } as Incident;
    expect(IncidentMapper.toDto(i).photo_url).toBeNull();
    i.photoSignedUrl = 'https://s3/firmada';
    expect(IncidentMapper.toDto(i).photo_url).toBe('https://s3/firmada');
  });

  it('logo de la distribuidora', () => {
    const d = { logoUrl: EXTERNA } as Distributor;
    expect(DistributorMapper.toDto(d).logo_url).toBeNull();
    d.photoSignedUrl = 'https://s3/firmada';
    expect(DistributorMapper.toDto(d).photoUrl).toBe('https://s3/firmada');
  });

  it('selfie del usuario', () => {
    const u = { selfie: EXTERNA } as User;
    expect(UserMapper.toDto(u).selfie).toBeNull();
  });
});
