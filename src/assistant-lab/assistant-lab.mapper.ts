import { TOPE_DE_CASOS } from './assistant-lab.dominio';
import type {
  RegressionCaseListResponseDto,
  RegressionCaseResponseDto,
  RegressionRunResponseDto,
  UnansweredListResponseDto,
} from './dto/assistant-lab.dto';
import type { AssistantRegressionCase } from './entities/assistant-regression-case.entity';
import type { AssistantRegressionRun } from './entities/assistant-regression-run.entity';
import type { PreguntasSinRespuesta } from './preguntas-sin-respuesta.service';

/** De lo interno a la respuesta: sin empresa, autores ni fechas de baja. */
export const AssistantLabMapper = {
  toUnansweredDto(p: PreguntasSinRespuesta): UnansweredListResponseDto {
    return {
      from: p.from,
      to: p.to,
      items: p.items.map((g) => ({
        id: g.id,
        question: g.question,
        count: g.count,
        firstSeenAt: g.firstSeenAt.toISOString(),
        lastSeenAt: g.lastSeenAt.toISOString(),
      })),
      truncated: p.truncated,
    };
  },

  toCaseDto(c: AssistantRegressionCase): RegressionCaseResponseDto {
    return {
      id: c.caseId,
      question: c.question,
      expected: c.expected,
      mustMention: c.mustMention,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  },

  toCaseListDto(
    casos: AssistantRegressionCase[],
  ): RegressionCaseListResponseDto {
    return {
      items: casos.map((c) => AssistantLabMapper.toCaseDto(c)),
      limit: TOPE_DE_CASOS,
    };
  },

  toRunDto(r: AssistantRegressionRun): RegressionRunResponseDto {
    return {
      id: r.runId,
      status: r.status,
      total: r.total,
      passed: r.passed,
      failed: r.failed,
      errored: r.errored,
      results: r.results,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    };
  },
};
