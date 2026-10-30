import { BadRequestException } from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { AttachmentOwnerType } from './entities/attachment.entity';

describe('AttachmentController · dueños que sólo entran por su endpoint', () => {
  const upload = jest.fn();
  const controller = new AttachmentController({
    upload,
  } as unknown as AttachmentService);
  const user = { user_id: 'u1', email: 'a@b.c', role: RoleType.ADMIN };

  it('no sube el comprobante de una cuota de seguro por /attachments', async () => {
    await expect(
      controller.upload(
        AttachmentOwnerType.INSURANCE_INSTALLMENT,
        'q1',
        {},
        undefined,
        'd1',
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upload).not.toHaveBeenCalled();
  });

  it('no sube el comprobante de una multa por /attachments', async () => {
    await expect(
      controller.upload(
        AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
        'm1',
        {},
        undefined,
        'd1',
        user,
      ),
    ).rejects.toThrow(/POST \/traffic-fines\/:id\/receipt/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('el resto de los dueños sigue subiendo', async () => {
    upload.mockResolvedValue({
      attachmentId: 'a1',
      ownerType: AttachmentOwnerType.INSURANCE_POLICY,
    });
    await controller.upload(
      AttachmentOwnerType.INSURANCE_POLICY,
      'p1',
      {},
      undefined,
      'd1',
      user,
    );
    expect(upload).toHaveBeenCalled();
  });
});
