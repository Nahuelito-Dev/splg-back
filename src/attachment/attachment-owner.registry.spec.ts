import { AttachmentOwnerRegistry } from './attachment-owner.registry';
import { AttachmentOwnerType } from './entities/attachment.entity';
import { AttachmentOwnerResolver } from './ports/attachment-owner-resolver.port';

function resolver(ownerType: AttachmentOwnerType): AttachmentOwnerResolver {
  return { ownerType, assertOwner: jest.fn() };
}

describe('AttachmentOwnerRegistry', () => {
  it('devuelve el resolver registrado para su tipo', () => {
    const registry = new AttachmentOwnerRegistry();
    const r = resolver(AttachmentOwnerType.EMPLOYEE);
    registry.register(r);
    expect(registry.find(AttachmentOwnerType.EMPLOYEE)).toBe(r);
  });

  it('devuelve undefined si nadie registró el tipo', () => {
    expect(
      new AttachmentOwnerRegistry().find(AttachmentOwnerType.FUEL_LOAD),
    ).toBeUndefined();
  });

  it('no deja registrar dos resolvers para el mismo tipo', () => {
    const registry = new AttachmentOwnerRegistry();
    registry.register(resolver(AttachmentOwnerType.EMPLOYEE));
    expect(() =>
      registry.register(resolver(AttachmentOwnerType.EMPLOYEE)),
    ).toThrow(/employee/);
  });
});
