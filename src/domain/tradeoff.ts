import { plans, scenario, serviceById } from './scenario';
import { certMinutesLeft, configApplies, dataLossMin, simulate } from './simulate';
import type {
  EffectEntry,
  PathAssessment,
  PlanParams,
  RunResult,
  Targets,
  Tradeoff,
} from './types';

export function assessPath(
  plan: PlanParams,
  targets: Targets,
  timeouts: Record<string, number>,
  appliedEffects: Record<string, EffectEntry>,
): PathAssessment {
  const run = simulate({ plan, targets, timeouts, appliedEffects });
  const rtoMin = run.rtoMin;
  const rpoMin = run.rpoMin;

  const rtoOk = rtoMin !== null && rtoMin <= targets.rto;
  const rpoOk = rpoMin !== null && rpoMin <= targets.rpo;

  const configServices = scenario.services
    .filter((s) => configApplies(s.id, plan))
    .map((s) => s.id);
  const deferredConfigServices = scenario.services
    .filter((s) => s.config && !configApplies(s.id, plan))
    .map((s) => s.id);

  const certServices = run.steps
    .filter((s) => s.kind === 'cert')
    .map((s) => s.serviceId);
  const certSet = new Set(certServices);
  const deferredCertServices = scenario.services
    .filter((s) => !certSet.has(s.id) && certMinutesLeft(s.id) < 60 * 24 * 30)
    .map((s) => s.id);

  const rpoBreachServices = scenario.services
    .filter((s) => dataLossMin(s.id, plan) > targets.rpo)
    .map((s) => ({ id: s.id, name: s.name, loss: dataLossMin(s.id, plan) }));

  const costs: string[] = [];
  const gains: string[] = [];

  if (plan.snapshotPolicy === 'local') {
    costs.push(
      `本地快照最新恢复点为 ${describeLag(plan, 'pay-db')} 前，核心库将丢失最多 ${dataLossMin(
        'pay-db',
        plan,
      )} 分钟已确认交易`,
    );
  } else {
    gains.push('备份库恢复点先做完整性校验，丢失窗口可压到 2–4 分钟');
    costs.push('每个服务先过 4–8 分钟完整性校验，恢复通道整体后移');
    costs.push('恢复通道只有 2 条，账务库与支付核心串行，尾延迟更长');
  }

  if (plan.configScope === 'tier1') {
    if (deferredConfigServices.length) {
      costs.push(
        `${deferredConfigServices.map((id) => serviceById[id].name).join('、')} 的配置漂移留到演练后补，切换后行为不一致`,
      );
    }
  } else {
    gains.push('全量配置对齐，切换后各环境行为一致');
    costs.push(`配置下发通道 ${plan.configLanes} 条，${configServices.length} 个服务排队，非核心服务也要等`);
  }

  if (plan.certWindowMin <= 150) {
    if (deferredCertServices.length) {
      costs.push(
        `${deferredCertServices.map((id) => serviceById[id].name).join('、')} 的证书不在本次续期窗口内，演练后仍需单独处理`,
      );
    }
    gains.push('只续期 48 小时内到期的证书，PKI 通道不被低优先级请求占满');
  } else {
    gains.push('证书全量续期，演练后半年内无到期风险');
    costs.push('PKI 通道单条，所有证书串行排队');
  }

  if (!plan.integrityScan) {
    costs.push('跳过恢复点校验，直接使用快照（假设快照可信）');
  }

  const rtoOverMin = rtoMin === null ? Number.POSITIVE_INFINITY : Math.max(0, rtoMin - targets.rto);
  const rpoOverMin = rpoMin === null ? Number.POSITIVE_INFINITY : Math.max(0, rpoMin - targets.rpo);

  return {
    plan,
    run,
    rtoMin,
    rpoMin,
    rtoOk,
    rpoOk,
    bothOk: rtoOk && rpoOk,
    rtoOverMin,
    rpoOverMin,
    rtoMarginMin: rtoMin === null ? Number.NEGATIVE_INFINITY : targets.rto - rtoMin,
    rpoMarginMin: rpoMin === null ? Number.NEGATIVE_INFINITY : targets.rpo - rpoMin,
    configServices,
    certServices,
    deferredConfigServices,
    deferredCertServices,
    scanServiceCount: plan.integrityScan ? scenario.services.length : 0,
    reuseCount: run.reusedEffectCount,
    rpoBreachServices,
    costs,
    gains,
  };
}

function describeLag(plan: PlanParams, id: string): string {
  return `${dataLossMin(id, plan)} 分钟`;
}

export function buildTradeoff(
  targets: Targets,
  timeouts: Record<string, number>,
  appliedEffects: Record<string, EffectEntry>,
): Tradeoff {
  const paths = plans.map((p) => assessPath(p, targets, timeouts, appliedEffects));
  const anyCompliant = paths.some((p) => p.bothOk);
  const allCompliant = paths.every((p) => p.bothOk);

  let headline: string;
  let recommendation: string;

  if (allCompliant) {
    headline = '两条路径都能同时达标，按代价选择即可。';
    recommendation = '两条路径均满足 RTO 与 RPO。优先选择无需操作者承担额外风险的路径。';
  } else if (anyCompliant) {
    const ok = paths.filter((p) => p.bothOk);
    headline = `只有「${ok.map((p) => p.plan.name).join('」「')}」能同时达标，另一条必须放弃一项。`;
    recommendation = '若不能接受另一条路径的代价，请选择可达标路径继续；否则需操作者明确接受突破。';
  } else {
    const rtoOnly = paths.filter((p) => p.rtoOk && !p.rpoOk);
    const rpoOnly = paths.filter((p) => !p.rtoOk && p.rpoOk);
    if (rtoOnly.length && rpoOnly.length) {
      headline = '没有路径能同时满足 RTO 与 RPO：一条快但旧，一条新但慢。';
      recommendation = '必须由操作者决定牺牲恢复时间还是牺牲数据。两条路径的代价都已在下方列出。';
    } else if (rtoOnly.length) {
      headline = '两条路径都达不到 RPO，只有恢复时间可以守住。';
      recommendation = '无论如何都会丢失超过目标的数据，请操作者确认可接受的数据损失量后再继续。';
    } else if (rpoOnly.length) {
      headline = '两条路径都达不到 RTO，数据丢失量可以守住。';
      recommendation = '恢复时间将超出目标，请操作者确认业务可容忍的停服时长后再继续。';
    } else {
      headline = '两条路径都无法达标：恢复时间与数据丢失量同时越界。';
      recommendation = '建议先缩小演练范围或增加恢复通道，再重新提交演练请求。';
    }
  }

  return { targets, paths, anyCompliant, allCompliant, needsDecision: !allCompliant, headline, recommendation };
}

export function breachList(run: RunResult): string[] {
  const out: string[] = [];
  if (run.rtoMin === null) {
    out.push('核心服务未全部可用，RTO 无法达标');
  } else if (run.rtoMin > run.targets.rto) {
    out.push(`RTO ${run.rtoMin}′ 超出目标 ${run.rtoMin - run.targets.rto}′`);
  }
  if (run.rpoMin !== null && run.rpoMin > run.targets.rpo) {
    out.push(`RPO ${run.rpoMin}′ 超出目标 ${run.rpoMin - run.targets.rpo}′`);
  }
  return out;
}
