import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { NotificationLog } from './entities/notification-log.entity';
import { NotificationLogService } from './notification-log.service';

const fila = (o: Partial<NotificationLog> = {}): NotificationLog =>
  ({
    notificationLogId: 'n1',
    createdAt: new Date('2026-11-24T12:00:00Z'),
    channel: 'email',
    type: 'CASH_READY',
    recipientMasked: 'n***@dominio.com',
    recipientUserId: null,
    subject: 'Asunto',
    status: 'sent',
    error: null,
    relatedOrderId: 'o1',
    distributorId: 'dist-a',
    ...o,
  }) as NotificationLog;

function armar() {
  const qb = {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[fila()], 1]),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    query: jest.fn(),
    find: jest.fn().mockResolvedValue([fila()]),
  };
  const service = new NotificationLogService(
    repo as unknown as Repository<NotificationLog>,
  );
  return { service, qb, repo };
}

describe('NotificationLogService', () => {
  it('lista con la distribuidora como primer filtro y devuelve el DTO sin datos de más', async () => {
    const { service, qb } = armar();
    const r = await service.listar('dist-a', { limit: 5, offset: 10 });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'n.distributor_id = :distributorId',
      { distributorId: 'dist-a' },
    );
    expect(qb.take).toHaveBeenCalledWith(5);
    expect(qb.skip).toHaveBeenCalledWith(10);
    expect(r).toEqual({
      data: [
        {
          notificationLogId: 'n1',
          createdAt: new Date('2026-11-24T12:00:00Z'),
          channel: 'email',
          type: 'CASH_READY',
          recipientMasked: 'n***@dominio.com',
          subject: 'Asunto',
          status: 'sent',
          error: null,
          orderId: 'o1',
          distributorId: 'dist-a',
        },
      ],
      total: 1,
      limit: 5,
      offset: 10,
    });
  });

  it('no expone el id del destinatario aunque la fila lo tenga', async () => {
    const { service, qb } = armar();
    qb.getManyAndCount.mockResolvedValue([
      [fila({ recipientUserId: 'u-secreto' })],
      1,
    ]);
    const r = await service.listar('dist-a', {});
    expect(JSON.stringify(r)).not.toContain('u-secreto');
    expect(r.data[0]).not.toHaveProperty('recipientUserId');
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(qb.skip).toHaveBeenCalledWith(0);
  });

  it('los días argentinos pasan a límites de instante sobre created_at, sin funciones en la columna', async () => {
    const { service, qb } = armar();
    await service.listar('dist-a', { from: '2026-11-01', to: '2026-11-30' });
    expect(qb.andWhere).toHaveBeenCalledWith('n.created_at >= :desde', {
      desde: new Date('2026-11-01T03:00:00.000Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('n.created_at <= :hasta', {
      hasta: new Date('2026-12-01T02:59:59.999Z'),
    });
    const sql = (qb.andWhere.mock.calls as string[][]).map((c) => c[0]).join();
    expect(sql).not.toContain('AT TIME ZONE');
  });

  it('aplica canal, estado, tipo, pedido y término (escapando los comodines)', async () => {
    const { service, qb } = armar();
    await service.listar('dist-a', {
      channel: 'push' as never,
      status: 'failed' as never,
      type: 'ORDER_ARRIVED',
      orderId: 'o1',
      term: '50%_x',
    });
    const condiciones = (qb.andWhere.mock.calls as string[][]).map((c) => c[0]);
    expect(condiciones).toEqual(
      expect.arrayContaining([
        'n.channel = :channel',
        'n.status = :status',
        'n.type = :type',
        'n.related_order_id = :orderId',
        '(n.recipient_masked ILIKE :term OR n.subject ILIKE :term)',
      ]),
    );
    expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
      term: '%50\\%\\_x%',
    });
  });

  it('los avisos de un pedido ajeno son 404 y ni consulta el registro', async () => {
    const { service, repo } = armar();
    repo.query.mockResolvedValue([]);
    await expect(service.deUnPedido('o1', 'dist-b')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.query).toHaveBeenCalledWith(expect.any(String), [
      'o1',
      'dist-b',
    ]);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('los avisos de un pedido propio salen del más nuevo al más viejo', async () => {
    const { service, repo } = armar();
    repo.query.mockResolvedValue([{ order_id: 'o1' }]);
    const r = await service.deUnPedido('o1', 'dist-a');
    expect(r).toHaveLength(1);
    expect(repo.find).toHaveBeenCalledWith({
      where: { relatedOrderId: 'o1', distributorId: 'dist-a' },
      order: { createdAt: 'DESC', notificationLogId: 'DESC' },
      take: 200,
    });
  });
});
