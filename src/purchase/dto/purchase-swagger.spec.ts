import 'reflect-metadata';
import { UpdateWarehouseDto } from '../../stock/dto/warehouse.dto';
import { CreatePurchaseOrderDto } from './purchase-order.dto';
import { CreatePurchaseReceiptDto } from './purchase-receipt.dto';
import { CreateSupplierDto, UpdateSupplierDto } from './supplier.dto';

type Meta = { type?: unknown; nullable?: boolean; default?: unknown };

const meta = (clase: new () => object, propiedad: string): Meta =>
  Reflect.getMetadata(
    'swagger/apiModelProperties',
    clase.prototype as object,
    propiedad,
  ) as Meta;

describe('OpenAPI de proveedores, órdenes y recepciones', () => {
  const nulables: Array<[new () => object, string, unknown]> = [
    [CreateSupplierDto, 'contactName', String],
    [CreateSupplierDto, 'phone', String],
    [CreateSupplierDto, 'email', String],
    [CreateSupplierDto, 'address', String],
    [CreateSupplierDto, 'paymentTermsDays', Number],
    [UpdateSupplierDto, 'contactName', String],
    [UpdateSupplierDto, 'paymentTermsDays', Number],
    [CreatePurchaseOrderDto, 'notes', String],
    [CreatePurchaseReceiptDto, 'notes', String],
  ];

  it.each(nulables)(
    '%p.%s se documenta con su tipo real y nulable, no como object',
    (clase, propiedad, tipo) => {
      expect(meta(clase, propiedad)).toMatchObject({
        type: tipo,
        nullable: true,
      });
    },
  );

  it('UpdateWarehouseDto.kind es un enum sin default: un PATCH sin kind no lo cambia', () => {
    const kind = meta(UpdateWarehouseDto, 'kind');
    expect(kind).toBeDefined();
    expect(kind.default).toBeUndefined();
  });
});
