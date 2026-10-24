/**
 * Largo máximo de los textos libres que carga una persona (mismo valor en el DTO,
 * en el CHECK de la base y en el panel). Los CHECK cuentan caracteres
 * (`char_length`), igual que `@MaxLength`.
 */
/** Motivo de un reclamo (el título corto). */
export const LARGO_MOTIVO_DE_RECLAMO = 120;
/** Descripciones y resoluciones: reclamos e incidencias. */
export const LARGO_DESCRIPCION = 1000;
/** Notas y motivos de una resolución, un descarte, una moderación o un impago. */
export const LARGO_NOTA = 500;
/** Mínimo de la nota con la que se resuelve un impago (lo mismo que exige el panel). */
export const LARGO_MINIMO_NOTA_DE_IMPAGO = 10;
