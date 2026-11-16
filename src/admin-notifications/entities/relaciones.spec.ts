import { getMetadataArgsStorage } from 'typeorm';
import { AdminNotification } from './admin-notification.entity';
import { AdminNotificationRead } from './admin-notification-read.entity';
import { User } from '../../users/entities/user.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

/** Las FK de la bandeja apuntan a donde dice la migración. */
describe('relaciones de la bandeja del admin', () => {
  const relaciones = (entidad: object) =>
    getMetadataArgsStorage().relations.filter((r) => r.target === entidad);

  const destino = (r: { type: unknown }): unknown =>
    typeof r.type === 'function' ? (r.type as () => unknown)() : r.type;

  it('el aviso es de una distribuidora', () => {
    const [distribuidora] = relaciones(AdminNotification);
    expect(destino(distribuidora)).toBe(Distributor);
  });

  it('la lectura es de un aviso (se borra con él) y de un usuario', () => {
    const porPropiedad = Object.fromEntries(
      relaciones(AdminNotificationRead).map((r) => [r.propertyName, r]),
    );
    expect(destino(porPropiedad.notification)).toBe(AdminNotification);
    expect(porPropiedad.notification.options.onDelete).toBe('CASCADE');
    expect(destino(porPropiedad.user)).toBe(User);
  });
});
