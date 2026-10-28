/**
 * Orígenes web permitidos (`CORS_ORIGINS`, separados por comas). Sin lista no
 * se admite ningún origen cross-site: es la política segura por defecto.
 */
export function origenesPermitidos(
  valor: string | undefined = process.env.CORS_ORIGINS,
): string[] {
  return (valor ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Si una conexión de tiempo real puede entrar según su `Origin`. Las apps
 * nativas no mandan `Origin` y entran (las autentica el token); un navegador
 * siempre lo manda, y desde otra página se rechaza. Hace falta además del
 * CORS porque el transporte websocket no pasa por él.
 */
export function origenDeSocketPermitido(
  origen: string | undefined,
  permitidos: string[],
): boolean {
  return origen === undefined || permitidos.includes(origen);
}
