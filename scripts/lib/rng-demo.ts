/** Azar reproducible para los seeds: misma semilla, mismos datos en cada corrida. */
export interface Azar {
  (): number;
}

export function crearAzar(semillaInicial: number): Azar {
  let semilla = semillaInicial;
  return () => {
    semilla = (semilla + 0x6d2b79f5) >>> 0;
    let t = semilla;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CUIT/CUIL bien formado (dígito verificador módulo 11) a partir de prefijo y número. */
export function cuitDe(prefijo: string, numero: string): string {
  const base = `${prefijo}${numero.padStart(8, '0')}`;
  const factores = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = factores.reduce((acc, f, i) => acc + f * Number(base[i]), 0);
  const resto = suma % 11;
  const verificador = resto === 0 ? 0 : 11 - resto;
  if (verificador === 10) {
    throw new Error(`El CUIT ${base} no tiene dígito verificador válido`);
  }
  return `${base}${verificador}`;
}

/** CUIL de un DNI: el primer prefijo de la lista que da un dígito verificador válido. */
export function cuilValido(dni: string, prefijos: readonly string[]): string {
  for (const prefijo of prefijos) {
    try {
      return cuitDe(prefijo, dni);
    } catch {
      continue;
    }
  }
  throw new Error(
    `El DNI ${dni} no tiene un CUIL válido con los prefijos dados`,
  );
}
