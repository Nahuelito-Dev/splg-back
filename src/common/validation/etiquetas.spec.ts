import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getMetadataStorage, type ValidationError } from 'class-validator';
import { ESQUEMAS } from '../../distributor/process-config';
import { ETIQUETAS_CAMPOS } from './etiquetas-campos';
import { ETIQUETAS_VALORES } from './etiquetas-valores';
import { etiquetaDeCampo, etiquetaDeValor, rutaLegible } from './etiquetas';
import { traducirErrores } from './traducir-validacion';

interface Metadato {
  propertyName: string;
  name?: string;
  constraints?: unknown[];
  message?: unknown;
  target: { name: string };
}

/** Importa todos los archivos del código que usan class-validator y devuelve sus metadatos. */
function metadatosDeTodosLosDtos(): Metadato[] {
  const archivos: string[] = [];
  const recorrer = (dir: string): void => {
    for (const nombre of readdirSync(dir)) {
      const ruta = join(dir, nombre);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (
        ruta.endsWith('.ts') &&
        !ruta.endsWith('.spec.ts') &&
        readFileSync(ruta, 'utf8').includes("from 'class-validator'")
      ) {
        archivos.push(ruta);
      }
    }
  };
  recorrer(join(__dirname, '..', '..'));
  for (const archivo of archivos) jest.requireActual(archivo);
  const almacen = getMetadataStorage() as unknown as {
    validationMetadatas: Map<unknown, Metadato[]>;
  };
  return [...almacen.validationMetadatas.values()].flat();
}

/** Los valores que acepta de verdad la restricción, leídos de su metadata. */
function valoresDe(m: Metadato): string[] {
  const c = m.constraints ?? [];
  if (m.name === 'isIn') return (c[0] as unknown[]).map(String);
  if (m.name === 'isEnum') {
    const entidad = c[0] as Record<string, unknown>;
    return Object.keys(entidad).map((k) => String(entidad[k]));
  }
  return [];
}

describe('etiquetas: completitud', () => {
  const metadatos = metadatosDeTodosLosDtos();

  it('encuentra los DTOs (si no, el test no prueba nada)', () => {
    expect(metadatos.length).toBeGreaterThan(1000);
  });

  it('todo campo validado tiene etiqueta', () => {
    const sin = new Set<string>();
    for (const m of metadatos) {
      if (!etiquetaDeCampo(m.propertyName, m.target.name)) {
        sin.add(m.propertyName);
      }
    }
    expect([...sin].sort()).toEqual([]);
  });

  it('ningún @IsEnum recibe un array (class-validator pierde la lista del mensaje): se usa @IsIn', () => {
    const mal = metadatos
      .filter((m) => m.name === 'isEnum' && Array.isArray(m.constraints?.[0]))
      .map((m) => `${m.target.name}.${m.propertyName}`);
    expect(mal).toEqual([]);
  });

  it('toda restricción de enum o lista tiene valores que controlar', () => {
    const vacias = metadatos
      .filter((m) => m.name === 'isEnum' || m.name === 'isIn')
      .filter((m) => valoresDe(m).length === 0)
      .map((m) => `${m.target.name}.${m.propertyName}`);
    expect(vacias).toEqual([]);
  });

  it('todo valor de enum validado tiene etiqueta', () => {
    const sin = new Set<string>();
    for (const m of metadatos) {
      for (const v of valoresDe(m)) {
        if (!etiquetaDeValor(v, m.propertyName))
          sin.add(`${m.propertyName}:${v}`);
      }
    }
    expect([...sin].sort()).toEqual([]);
  });

  it('todo parámetro de proceso automático tiene etiqueta', () => {
    const sin = Object.values(ESQUEMAS)
      .flatMap((e) => e.fields.map((f) => f.key))
      .filter((k) => !etiquetaDeCampo(k));
    expect(sin).toEqual([]);
  });

  it('un mensaje propio de un DTO no deja nombres internos a la vista', () => {
    const feos: string[] = [];
    for (const m of metadatos) {
      if (typeof m.message !== 'string') continue;
      const error = {
        property: m.propertyName,
        constraints: { [m.name ?? 'custom']: m.message },
      } as ValidationError;
      const [salida] = traducirErrores([error]);
      if (/\b[a-z][a-z0-9]*(?:[A-Z]\w*|(?:_[a-z0-9]+)+)\b/.test(salida)) {
        feos.push(`${m.target.name}.${m.propertyName}: ${salida}`);
      }
    }
    expect(feos).toEqual([]);
  });

  it('un mensaje propio nunca queda con dos «: » seguidos', () => {
    const dobles: string[] = [];
    for (const m of metadatos) {
      if (typeof m.message !== 'string') continue;
      const [salida] = traducirErrores([
        {
          property: m.propertyName,
          constraints: { [m.name ?? 'custom']: m.message },
        } as ValidationError,
      ]);
      if ((salida.match(/: /g) ?? []).length > 1) {
        dobles.push(`${m.target.name}.${m.propertyName}: ${salida}`);
      }
    }
    expect(dobles).toEqual([]);
  });

  it('el diccionario no tiene entradas vacías', () => {
    expect(Object.values(ETIQUETAS_CAMPOS).every((t) => t.trim() !== '')).toBe(
      true,
    );
    expect(Object.values(ETIQUETAS_VALORES).every((t) => t.trim() !== '')).toBe(
      true,
    );
  });
});

describe('etiquetas', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'el nombre «%s» no se confunde con una clave del diccionario',
    (nombre) => {
      expect(etiquetaDeCampo(nombre)).toBeUndefined();
      expect(etiquetaDeCampo(nombre, 'CreateCarDto')).toBeUndefined();
      expect(etiquetaDeValor(nombre)).toBeUndefined();
      expect(etiquetaDeValor(nombre, 'status')).toBeUndefined();
      expect(rutaLegible([nombre])).toBe('');
    },
  );

  it('el estado de la documentación sale de una sola fuente: el dominio', () => {
    expect(etiquetaDeValor('expired', 'documentStatus')).toBe('vencida');
    expect(etiquetaDeValor('expired', 'status')).toBe('vencido');
    expect(etiquetaDeValor('up_to_date', 'documentStatus')).toBe('al día');
  });

  it('el nombre genérico cambia según el DTO', () => {
    expect(etiquetaDeCampo('user_id', 'CreateCarDto')).toBe('Chofer');
    expect(etiquetaDeCampo('user_id', 'CreateCustomerDto')).toBe(
      'Usuario del cliente',
    );
    expect(etiquetaDeCampo('user_id')).toBe('Usuario');
    expect(etiquetaDeCampo('name', 'CreateWarehouseDto')).toBe(
      'Nombre del depósito',
    );
  });

  it('los valores van en minúscula dentro de una frase, salvo las siglas', () => {
    expect(etiquetaDeValor('up_to_date')).toBe('al día');
    expect(etiquetaDeValor('vtv')).toBe('VTV');
    expect(etiquetaDeValor('ios')).toBe('iOS');
  });

  it('una etiqueta de valor por campo pisa a la general', () => {
    expect(etiquetaDeValor('delivery', 'role')).toBe('chofer');
    expect(etiquetaDeValor('delivery')).toBe('entrega');
  });

  it('la ruta de un campo anidado numera los elementos y omite lo que no tiene etiqueta', () => {
    expect(rutaLegible(['items', '1', 'quantity'])).toBe('Ítem 2 · Cantidad');
    expect(rutaLegible(['campoInventado'])).toBe('');
  });
});
