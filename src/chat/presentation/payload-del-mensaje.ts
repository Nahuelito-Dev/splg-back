/**
 * El `payload` como lo ve quien mira: las fuentes de la respuesta del
 * asistente con IA (`ai.sources`, 4d) son para quien atiende (el personal en
 * la bandeja, la plataforma en el soporte); a la otra punta (el cliente, el
 * chofer, la empresa en C1) nunca le llegan.
 */
export function payloadPara(
  payload: Record<string, unknown> | null,
  personal: boolean,
): Record<string, unknown> | null {
  if (personal || !payload) return payload;
  const ai = payload.ai;
  if (typeof ai !== 'object' || ai === null || !('sources' in ai)) {
    return payload;
  }
  const { sources: _fuentes, ...resto } = ai as Record<string, unknown>;
  void _fuentes;
  return { ...payload, ai: resto };
}
