/**
 * Catálogo de documentos que lee el módulo M6 y los campos de cada uno. El
 * lector recibe este catálogo en sus instrucciones y devuelve sólo estos campos.
 */

export enum TipoDeDocumento {
  COMPROBANTE_DE_PAGO = 'comprobante_de_pago',
  FACTURA_O_REMITO = 'factura_o_remito',
  POLIZA = 'poliza',
  REVISION_TECNICA = 'revision_tecnica',
  CEDULA_DEL_VEHICULO = 'cedula_del_vehiculo',
  LICENCIA_DE_CONDUCIR = 'licencia_de_conducir',
  APTO_MEDICO = 'apto_medico',
  OTRO = 'otro',
}

export interface DefinicionDeCampo {
  nombre: string;
  descripcion: string;
}

export interface DefinicionDeDocumento {
  tipo: TipoDeDocumento;
  descripcion: string;
  campos: DefinicionDeCampo[];
}

const FECHA = 'fecha en formato AAAA-MM-DD';
const IMPORTE =
  'importe con punto decimal y sin separador de miles, ej. "38390.00"';
const CUIT = 'CUIT de 11 dígitos, sólo números';
const PATENTE =
  'patente en mayúsculas y sin espacios ni guiones, ej. "AB123CD"';
const DNI = 'número de documento, sólo dígitos';

export const CATALOGO_DE_DOCUMENTOS: readonly DefinicionDeDocumento[] = [
  {
    tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
    descripcion:
      'Comprobante de un pago hecho: recibo de una aseguradora, pago de una multa, transferencia, ticket de Mercado Pago',
    campos: [
      { nombre: 'importe', descripcion: `Importe pagado: ${IMPORTE}` },
      {
        nombre: 'fecha_de_pago',
        descripcion:
          'Fecha y hora del pago en ISO 8601; sin zona horaria, usar -03:00',
      },
      {
        nombre: 'numero_de_operacion',
        descripcion: 'Número de operación, transacción o comprobante',
      },
      {
        nombre: 'destinatario',
        descripcion: 'A quién se le pagó: aseguradora, municipio, organismo',
      },
      { nombre: 'cuit_del_destinatario', descripcion: CUIT },
      {
        nombre: 'periodo',
        descripcion: 'Período que cubre el pago, formato AAAA-MM',
      },
    ],
  },
  {
    tipo: TipoDeDocumento.FACTURA_O_REMITO,
    descripcion: 'Factura, remito o nota de un proveedor',
    campos: [
      {
        nombre: 'numero',
        descripcion: 'Número del comprobante, ej. "0001-00001234"',
      },
      { nombre: 'fecha', descripcion: FECHA },
      {
        nombre: 'razon_social_del_emisor',
        descripcion: 'Nombre del proveedor',
      },
      { nombre: 'cuit_del_emisor', descripcion: CUIT },
      { nombre: 'total', descripcion: `Total del comprobante: ${IMPORTE}` },
      { nombre: 'iva', descripcion: `IVA discriminado, si figura: ${IMPORTE}` },
      {
        nombre: 'items',
        descripcion:
          'Renglones como texto JSON: lista de {"descripcion","cantidad","precio_unitario"}',
      },
    ],
  },
  {
    tipo: TipoDeDocumento.POLIZA,
    descripcion: 'Póliza o certificado de cobertura de un seguro de vehículo',
    campos: [
      { nombre: 'aseguradora', descripcion: 'Compañía de seguros' },
      { nombre: 'numero_de_poliza', descripcion: 'Número de póliza' },
      { nombre: 'patente', descripcion: PATENTE },
      { nombre: 'vigencia_desde', descripcion: FECHA },
      { nombre: 'vigencia_hasta', descripcion: FECHA },
      { nombre: 'prima', descripcion: `Prima o premio mensual: ${IMPORTE}` },
    ],
  },
  {
    tipo: TipoDeDocumento.REVISION_TECNICA,
    descripcion:
      'Certificado de revisión técnica del vehículo (RTO en Misiones, VTV en otras provincias)',
    campos: [
      { nombre: 'patente', descripcion: PATENTE },
      { nombre: 'fecha_de_revision', descripcion: FECHA },
      { nombre: 'vencimiento', descripcion: FECHA },
      {
        nombre: 'resultado',
        descripcion: '"apto", "condicional" o "rechazado"',
      },
    ],
  },
  {
    tipo: TipoDeDocumento.CEDULA_DEL_VEHICULO,
    descripcion: 'Cédula de identificación del automotor',
    campos: [
      { nombre: 'patente', descripcion: PATENTE },
      { nombre: 'titular', descripcion: 'Nombre del titular' },
      { nombre: 'marca', descripcion: 'Marca del vehículo' },
      { nombre: 'modelo', descripcion: 'Modelo del vehículo' },
      { nombre: 'anio', descripcion: 'Año del modelo, cuatro dígitos' },
      {
        nombre: 'vencimiento',
        descripcion: `Vencimiento de la cédula, si figura: ${FECHA}`,
      },
    ],
  },
  {
    tipo: TipoDeDocumento.LICENCIA_DE_CONDUCIR,
    descripcion: 'Licencia de conducir',
    campos: [
      { nombre: 'titular', descripcion: 'Nombre y apellido' },
      { nombre: 'documento', descripcion: DNI },
      {
        nombre: 'categoria',
        descripcion: 'Clases o categorías habilitadas, ej. "B1, D1"',
      },
      { nombre: 'vencimiento', descripcion: FECHA },
    ],
  },
  {
    tipo: TipoDeDocumento.APTO_MEDICO,
    descripcion: 'Certificado de aptitud médica o psicofísica',
    campos: [
      { nombre: 'titular', descripcion: 'Nombre y apellido' },
      { nombre: 'documento', descripcion: DNI },
      { nombre: 'fecha', descripcion: FECHA },
      { nombre: 'vencimiento', descripcion: FECHA },
      { nombre: 'resultado', descripcion: '"apto" o "no apto"' },
    ],
  },
  {
    tipo: TipoDeDocumento.OTRO,
    descripcion: 'Cualquier otro documento: no se extraen campos',
    campos: [],
  },
];

export const NOMBRES_DE_CAMPOS: readonly string[] = [
  ...new Set(
    CATALOGO_DE_DOCUMENTOS.flatMap((d) => d.campos.map((c) => c.nombre)),
  ),
];

export function camposDe(tipo: TipoDeDocumento): readonly DefinicionDeCampo[] {
  return CATALOGO_DE_DOCUMENTOS.find((d) => d.tipo === tipo)?.campos ?? [];
}
