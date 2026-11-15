import { MigrationInterface, QueryRunner } from 'typeorm';

/** Los módulos del catálogo al correr esta migración (con y sin el asistente). */
const MODULOS_ANTES = [
  'document_reading',
  'route_planning',
  'route_batching',
  'repurchase',
  'cylinder_recovery',
  'fleet_planner',
  'whatsapp',
  'mercadopago',
  'express',
  'chat',
];
const MODULOS_DESPUES = [...MODULOS_ANTES, 'assistant'];

const checkDeModulos = (modulos: string[]): string =>
  `"module_key" IN (${modulos.map((m) => `'${m}'`).join(', ')})`;

/** Las tablas cuyo CHECK acota la clave de módulo al catálogo. */
const TABLAS_CON_MODULO = [
  ['distributor_module', 'CHK_distributor_module_clave'],
  ['platform_plan_module', 'CHK_platform_plan_module_clave'],
] as const;

/**
 * Texto plano: ni etiquetas (`<b>`, `</p>`, `<!--`) ni entidades HTML (`&`
 * seguido de una letra o `#`, con o sin `;`). Un `<` o un `&` sueltos pasan.
 */
const sinHtml = (columna: string): string =>
  `"${columna}" !~ '<[A-Za-z/!?]' AND "${columna}" !~ '&[A-Za-z#]'`;

/**
 * Plantillas iniciales de OrixTech (DISENO-CH-BOT §9 D-B4): preguntas de los
 * clientes que valen para cualquier distribuidora porque remiten a lo que la
 * app ya muestra; cada una las copia (`from-templates`) y las ajusta.
 */
const PLANTILLAS: ReadonlyArray<
  [clave: string, pregunta: string, respuesta: string]
> = [
  [
    'como_hacer_un_pedido',
    '¿Cómo hago un pedido?',
    'Desde la app: elegí las garrafas, la dirección de entrega y el medio de pago, y confirmá el pedido. En la app ves en qué estado está hasta que te llega.',
  ],
  [
    'medios_de_pago',
    '¿Qué medios de pago aceptan?',
    'Los medios de pago que acepta la distribuidora aparecen en la app al confirmar el pedido.',
  ],
  [
    'horarios_de_entrega',
    '¿En qué horario entregan?',
    'Los horarios de entrega disponibles para tu dirección aparecen en la app cuando hacés el pedido.',
  ],
  [
    'zona_de_cobertura',
    '¿Llegan a mi zona?',
    'Cargá tu dirección en la app: si está dentro de la zona de cobertura vas a poder hacer el pedido; si no, la app te avisa.',
  ],
  [
    'estado_del_pedido',
    '¿Dónde está mi pedido?',
    'En la app ves el estado de cada pedido y, cuando sale a entregarse, quién lo lleva. Si algo no cierra, escribinos por acá y alguien del equipo te ayuda.',
  ],
];

/**
 * Asistente del chat, etapa B2 (DISENO-CH-BOT §4.3, §5 y §9): base de
 * conocimiento por distribuidora y de la plataforma.
 *
 * 1. Módulo M8 `assistant` en el catálogo: amplía los CHECK de clave de módulo
 *    de `distributor_module` y `platform_plan_module`. Ningún plan lo trae
 *    (apagado por omisión): la plataforma lo habilita empresa por empresa.
 * 2. `assistant_knowledge_base`: la cabecera de cada base (una por empresa,
 *    una de la plataforma con `distributor_id` nulo, única por índice
 *    parcial), con la `version` que sube con cada cambio. Es la fila que el
 *    servicio bloquea en cada escritura.
 * 3. `assistant_faq`: las preguntas. Largos (5–200 y 1–1500, en caracteres
 *    como los cuenta Postgres), texto sin HTML, `position` (el orden en la
 *    base, ≥ 1; las copias de plantillas conservan el de la plataforma),
 *    clave en formato de slug (obligatoria en la plataforma), sólo la
 *    plataforma ofrece plantillas, baja lógica (`deleted_at`) y únicos
 *    parciales entre las vigentes de cada base: la clave y la pregunta (sin
 *    mayúsculas ni espacios de los bordes). Tenant cruzado: la FK compuesta
 *    `(knowledge_base_id, distributor_id)` impide que la pregunta de una
 *    empresa cuelgue de la base de otra (está en `CLAVES_CRUZADAS_POSTERIORES`).
 * 4. La base de la plataforma con las plantillas iniciales (versión 1).
 *
 * La auditoría de las dos tablas la instala la migración que genera
 * `npm run auditoria:mapa -- --migracion AuditoriaDeLaBaseDeConocimiento`.
 *
 * Escrita a mano con los nombres que fijan las entidades: `migration:generate`
 * necesita una base.
 */
export class BaseDeConocimientoDelAsistente1795000000110
  implements MigrationInterface
{
  name = 'BaseDeConocimientoDelAsistente1795000000110';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [tabla, restriccion] of TABLAS_CON_MODULO) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${restriccion}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${restriccion}" CHECK (${checkDeModulos(MODULOS_DESPUES)})`,
      );
    }

    await queryRunner.query(
      `CREATE TABLE "assistant_knowledge_base" ("knowledge_base_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid, "version" integer NOT NULL DEFAULT '0', "updated_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_assistant_knowledge_base_id_distribuidora" UNIQUE ("knowledge_base_id", "distributor_id"), CONSTRAINT "UQ_assistant_knowledge_base_distribuidora" UNIQUE ("distributor_id"), CONSTRAINT "CHK_assistant_knowledge_base_version" CHECK ("version" >= 0), CONSTRAINT "PK_assistant_knowledge_base" PRIMARY KEY ("knowledge_base_id"))`,
    );
    // Una sola base de la plataforma (el único de arriba no la cubre: los nulos son distintos).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_knowledge_base_plataforma" ON "assistant_knowledge_base" (("distributor_id" IS NULL)) WHERE "distributor_id" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_knowledge_base" ADD CONSTRAINT "FK_assistant_knowledge_base_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TABLE "assistant_faq" ("faq_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "knowledge_base_id" uuid NOT NULL, "distributor_id" uuid, "key" character varying(60), "question" character varying(200) NOT NULL, "answer" character varying(1500) NOT NULL, "position" integer NOT NULL, "use_as_template" boolean NOT NULL DEFAULT false, "created_by" uuid, "updated_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_assistant_faq_posicion" CHECK ("position" >= 1), CONSTRAINT "CHK_assistant_faq_plantilla" CHECK ("distributor_id" IS NULL OR NOT "use_as_template"), CONSTRAINT "CHK_assistant_faq_clave_de_plataforma" CHECK ("distributor_id" IS NOT NULL OR "key" IS NOT NULL), CONSTRAINT "CHK_assistant_faq_clave" CHECK ("key" IS NULL OR "key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'), CONSTRAINT "CHK_assistant_faq_sin_html" CHECK (${sinHtml('question')} AND ${sinHtml('answer')}), CONSTRAINT "CHK_assistant_faq_respuesta" CHECK (char_length(btrim("answer")) BETWEEN 1 AND 1500), CONSTRAINT "CHK_assistant_faq_pregunta" CHECK (char_length(btrim("question")) BETWEEN 5 AND 200), CONSTRAINT "PK_assistant_faq" PRIMARY KEY ("faq_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assistant_faq_distribuidora" ON "assistant_faq" ("distributor_id", "position") `,
    );
    // Únicos entre las vigentes de cada base: una baja lógica libera la clave y la pregunta.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_faq_clave_vigente" ON "assistant_faq" ("knowledge_base_id", "key") WHERE "key" IS NOT NULL AND "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_faq_pregunta_vigente" ON "assistant_faq" ("knowledge_base_id", lower(btrim("question"))) WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD CONSTRAINT "FK_assistant_faq_knowledge_base" FOREIGN KEY ("knowledge_base_id") REFERENCES "assistant_knowledge_base"("knowledge_base_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD CONSTRAINT "FK_assistant_faq_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    // Tenant cruzado (misma forma que `sqlDeClave` de `sql/tenant-cruzado.ts`).
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD CONSTRAINT "FK_assistant_faq_knowledge_base_distribuidora" FOREIGN KEY ("knowledge_base_id", "distributor_id") REFERENCES "assistant_knowledge_base" ("knowledge_base_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // La base de la plataforma con las plantillas iniciales: versión 1 (un cambio).
    const [base] = (await queryRunner.query(
      `INSERT INTO "assistant_knowledge_base" ("distributor_id", "version") VALUES (NULL, 1) RETURNING "knowledge_base_id" AS "id"`,
    )) as Array<{ id: string }>;
    for (const [i, [clave, pregunta, respuesta]] of PLANTILLAS.entries()) {
      await queryRunner.query(
        `INSERT INTO "assistant_faq" ("knowledge_base_id", "distributor_id", "key", "question", "answer", "position", "use_as_template") VALUES ($1, NULL, $2, $3, $4, $5, true)`,
        [base.id, clave, pregunta, respuesta, i + 1],
      );
    }
  }

  /**
   * Deshace todo. Las preguntas cargadas se pierden con sus tablas y, para
   * poder volver al CHECK sin `assistant`, se quitan las excepciones y los
   * planes que habilitaban el módulo (sin el módulo en el catálogo no
   * significan nada).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP CONSTRAINT "FK_assistant_faq_knowledge_base_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP CONSTRAINT "FK_assistant_faq_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP CONSTRAINT "FK_assistant_faq_knowledge_base"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_faq_pregunta_vigente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_faq_clave_vigente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_assistant_faq_distribuidora"`,
    );
    await queryRunner.query(`DROP TABLE "assistant_faq"`);
    await queryRunner.query(
      `ALTER TABLE "assistant_knowledge_base" DROP CONSTRAINT "FK_assistant_knowledge_base_distributor"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_knowledge_base_plataforma"`,
    );
    await queryRunner.query(`DROP TABLE "assistant_knowledge_base"`);

    for (const [tabla, restriccion] of TABLAS_CON_MODULO) {
      await queryRunner.query(
        `DELETE FROM "${tabla}" WHERE "module_key" = 'assistant'`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${restriccion}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${restriccion}" CHECK (${checkDeModulos(MODULOS_ANTES)})`,
      );
    }
  }
}
