import {
  In,
  type DataSource,
  type EntityManager,
  type FindOperator,
} from 'typeorm';
import type { StaffPermissionsService } from '../../admin/staff-permissions.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Channel, Party } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';

/** Las conversaciones de la «base»: de dos empresas, dos canales y dos personas. */
const filas: Conversation[] = [
  ['c3-a', 'dist-a', Channel.STAFF_CUSTOMER, 'cli-1', null],
  ['c3-a-otro', 'dist-a', Channel.STAFF_CUSTOMER, 'cli-2', null],
  ['c2-a', 'dist-a', Channel.STAFF_DRIVER, null, 'cho-1'],
  ['c3-b', 'dist-b', Channel.STAFF_CUSTOMER, 'cli-1', null],
  ['c1-a', 'dist-a', Channel.PLATFORM_CHAT, null, null],
].map(
  ([conversationId, distributorId, channel, customerUserId, driverUserId]) =>
    Object.assign(new Conversation(), {
      conversationId,
      distributorId,
      channel,
      customerUserId,
      driverUserId,
    }),
);

/** Un `findOne` que aplica de verdad el `where` (con `In` para el canal) sobre las filas. */
function repositorio() {
  return {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        filas.find((f) =>
          Object.entries(where).every(([k, v]) => {
            const valor = (f as unknown as Record<string, unknown>)[k];
            const op = v as FindOperator<unknown>;
            return op?.type === 'in'
              ? (op.value as unknown[]).includes(valor)
              : valor === v;
          }),
        ) ?? null,
      ),
    ),
  };
}

function acceso() {
  const repo = repositorio();
  const manager = {
    getRepository: () => repo,
  } as unknown as EntityManager;
  const a = new BandejaAcceso(
    { manager } as unknown as DataSource,
    {
      deUsuario: jest
        .fn()
        .mockResolvedValue({ permisos: ['mensajes.choferes'] }),
    } as unknown as StaffPermissionsService,
  );
  return { a, repo };
}

const user = (id: string, role: RoleType) =>
  ({ user_id: id, role }) as AuthenticatedUser;

describe('BandejaAcceso.buscar: aislamiento por empresa, canal y persona', () => {
  it('el cliente encuentra la suya y no la de otro cliente, ni la de otra empresa, ni una C2 o C1', async () => {
    const { a } = acceso();
    const cliente = a.deLaPersona(user('cli-1', RoleType.CUSTOMER), 'dist-a');
    expect(cliente.party).toBe(Party.CUSTOMER);
    expect((await a.buscar(cliente, 'c3-a')).conversationId).toBe('c3-a');
    for (const ajena of ['c3-a-otro', 'c3-b', 'c2-a', 'c1-a', 'no-existe']) {
      await expect(a.buscar(cliente, ajena)).rejects.toMatchObject({
        message: 'No existe esa conversación',
      });
    }
  });

  it('el chofer sólo la suya de C2', async () => {
    const { a } = acceso();
    const chofer = a.deLaPersona(user('cho-1', RoleType.DELIVERY), 'dist-a');
    expect((await a.buscar(chofer, 'c2-a')).conversationId).toBe('c2-a');
    await expect(a.buscar(chofer, 'c3-a')).rejects.toBeTruthy();
    const otro = a.deLaPersona(user('cho-9', RoleType.DELIVERY), 'dist-a');
    await expect(a.buscar(otro, 'c2-a')).rejects.toBeTruthy();
  });

  it('el personal: su empresa y sólo los canales que atiende (sólo choferes no ve C3)', async () => {
    const { a, repo } = acceso();
    const soloChoferes = await a.delPersonal(
      user('adm-1', RoleType.ADMIN),
      'dist-a',
    );
    expect(soloChoferes.canales).toEqual([Channel.STAFF_DRIVER]);
    expect((await a.buscar(soloChoferes, 'c2-a')).conversationId).toBe('c2-a');
    await expect(a.buscar(soloChoferes, 'c3-a')).rejects.toBeTruthy();
    const completo: ActorDeLaBandeja = {
      ...soloChoferes,
      canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
    };
    expect((await a.buscar(completo, 'c3-a')).conversationId).toBe('c3-a');
    await expect(a.buscar(completo, 'c3-b')).rejects.toBeTruthy();
    await expect(a.buscar(completo, 'c1-a')).rejects.toBeTruthy();
    // Pedir un canal que no atiende no lo habilita.
    await expect(
      a.buscar(soloChoferes, 'c3-a', undefined, {
        canales: [Channel.STAFF_CUSTOMER],
      }),
    ).rejects.toBeTruthy();
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          distributorId: 'dist-a',
          channel: In([Channel.STAFF_DRIVER]),
        }) as unknown,
      }),
    );
  });
});
