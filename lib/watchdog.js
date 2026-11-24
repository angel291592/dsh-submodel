import { randomUUID } from 'node:crypto';
import { readLive, readModelGroups, readWatchdog, CONFIG_ENTRY } from './config.js';
import { HOST_SELECTION_ENTRY_ID, routeKey } from './policy.js';

const LIMITS = Object.freeze({ pending: 60_000, release: 30_000, attempt: 30 * 60_000 });
const RETRY_CODES = new Set(['RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'SERVER']);
const MIN_HOST_RETRIES = 5;
const USAGE_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const NAME = /^[a-z][a-z0-9-]{0,31}$/u;
const REMINDER = '请尽快收尾，优先交回已有结论、证据和待核实项。';
const NOTICE_SOURCE = 'dsh-submodel-watchdog';
const samePair = (left, right) => typeof left?.provider === 'string' && left.provider !== '' &&
  typeof left.model === 'string' && left.model !== '' && routeKey(left) === routeKey(right);
const endKey = ({ id, runId }) => JSON.stringify([id, runId]);
const shortId = () => randomUUID().slice(0, 12).replaceAll('-', '');

export function sumUsage(value) {
  if (!value) return undefined;
  let total = 0;
  for (const key of USAGE_KEYS) {
    const part = value[key];
    if (!Number.isSafeInteger(part) || part < 0) return undefined;
    total += part;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function includesContent(blocks) {
  return Array.isArray(blocks) && blocks.some(block => block?.type !== 'text' || Boolean(block.text?.trim()));
}

function observeAssistant(attempt, event) {
  const { usage, stream, message, turn } = event.data;
  if (turn !== attempt.turn) {
    attempt.incomplete = true;
    return;
  }
  if (message?.source?.kind === 'model' && !samePair(attempt.route, message.source)) attempt.routeChanged = true;
  if (includesContent(message?.content)) attempt.hasOutput = true;
  let streamedUsage;
  let finish;
  for (const record of Array.isArray(stream) ? stream : []) {
    if (record.type === 'chunk' && record.chunk?.type === 'finish') finish = record.chunk.reason?.kind;
    if (record.type === 'chunk' && record.chunk?.type === 'usage') streamedUsage = record.chunk.usage;
    if ((record.type === 'text-chunks' && record.texts?.some(text => text.trim())) ||
        record.type === 'tool-call-chunks' ||
        (record.type === 'reasoning-chunks' && record.texts?.some(text => text.trim())) ||
        (record.type === 'chunk' && (
          (['text-delta', 'reasoning-delta'].includes(record.chunk?.type) && record.chunk.text?.trim()) ||
          record.chunk?.type === 'tool-call-delta' ||
          (record.chunk?.type === 'block-start' && record.chunk.blockType === 'tool-call') ||
          (record.chunk?.type === 'block-end' && record.chunk.block && includesContent([record.chunk.block]))
        ))) attempt.hasOutput = true;
  }
  // A final reply can be durable while its turn still reports running. Inserting
  // input there would extend the turn and start another model request.
  attempt.waitForProgress = event.type !== 'assistant/message' || event.data.interrupted === true ||
    finish === 'max-tokens' || !message?.content?.some(block => block.type === 'tool-call');
  const reported = usage ?? streamedUsage;
  const total = reported == null ? undefined : sumUsage({
    uncachedInputTokens: reported.inputTokens,
    outputTokens: reported.outputTokens,
    cacheReadTokens: reported.cacheReadTokens === undefined ? 0 : reported.cacheReadTokens,
    cacheWriteTokens: reported.cacheWriteTokens === undefined ? 0 : reported.cacheWriteTokens,
  });
  // DSH rc.5 can emit the same all-zero chunk for a missing provider sample.
  // A previous step's usage cannot make the current failed attempt eligible.
  attempt.reportedUsage = total > 0 ? total : undefined;
  attempt.lastRequest = { step: event.data.step, seq: event.seq, usage: attempt.reportedUsage };
}

function notice(agent, text, id = randomUUID()) {
  agent.inject({
    id, role: 'user', content: [{ type: 'text', text }],
    source: { kind: NOTICE_SOURCE, form: 'notice', summary: text.slice(0, 120) },
  });
}

function laterModels(groups, tier, route) {
  const rows = tier === 'expert' ? groups.experts : groups.executors;
  const position = rows.findIndex(row => samePair(route, row));
  return position < 0 ? [] : rows.slice(position + 1).map(({ provider, model }) => ({ provider, model }));
}

/** 改派目标在所属组里的配置档位；未配置返回 undefined（交给模型默认）。 */
function candidateRowEffort(groups, tier, route) {
  const rows = tier === 'expert' ? groups.experts : groups.executors;
  const row = rows.find(item => samePair(item, route));
  return typeof row?.reasoningEffort === 'string' && row.reasoningEffort !== '' ? row.reasoningEffort : undefined;
}

function sameGroupOrder(frozen, current, tier) {
  const field = tier === 'expert' ? 'experts' : 'executors';
  const before = frozen[field];
  const after = current?.[field];
  return before.length === after?.length && before.every((row, index) => samePair(row, after[index]));
}

/** Pair the host's scheduled and started records in one run and one step. */
function observeRetry(attempt, event) {
  const data = event.data;
  const state = attempt.hostRetry ??= { started: 0 };
  if (state.invalid) return;
  if (data.turn !== attempt.turn || data.step !== attempt.step || data.retry !== state.started + 1 ||
      typeof data.retryId !== 'string' || data.retryId === '') {
    state.invalid = true;
    return;
  }
  if (event.type === 'llm/retry') {
    const sample = attempt.lastRequest;
    // A missing sample leaves cumulative usage unknown, even if later retries report usage.
    if (state.pending || data.provider !== attempt.route.provider || data.mode !== 'normal' ||
        !Number.isSafeInteger(data.maxRetries) || data.maxRetries < MIN_HOST_RETRIES || data.retry > data.maxRetries ||
        typeof data.policyKey !== 'string' || data.policyKey === '' ||
        (state.started > 0 && (state.id !== data.retryId || state.policyKey !== data.policyKey || state.limit !== data.maxRetries)) ||
        !sample || sample.step !== data.step || sample.seq <= (state.lastStart ?? -1) || sample.usage === undefined) {
      state.invalid = true;
      return;
    }
    state.id = data.retryId;
    state.policyKey = data.policyKey;
    state.limit = data.maxRetries;
    state.pending = true;
  } else if (state.pending && state.id === data.retryId) {
    state.pending = false;
    state.started = data.retry;
    state.lastStart = event.seq;
  } else {
    state.invalid = true;
  }
}

function hostRetriesExhausted(attempt) {
  const { hostRetry, lastRequest, failure, step } = attempt;
  return !!hostRetry && !hostRetry.invalid && !hostRetry.pending && hostRetry.started >= MIN_HOST_RETRIES &&
    hostRetry.started === hostRetry.limit && failure.retryLimit === hostRetry.limit &&
    lastRequest?.step === step && lastRequest.seq > hostRetry.lastStart && lastRequest.usage !== undefined;
}

function matchesEnd(attempt) {
  return attempt.turn !== undefined && attempt.failure !== undefined &&
    attempt.terminal?.stopReason === 'error' && attempt.terminal.turn === attempt.turn &&
    attempt.failure.turn === attempt.turn && attempt.failure.step === attempt.step &&
    attempt.failure.code === attempt.terminal.code && RETRY_CODES.has(attempt.failure.code) &&
    !attempt.incomplete && !attempt.hasOutput && !attempt.routeChanged && !attempt.cancelled &&
    attempt.initialId !== undefined && attempt.usage !== undefined &&
    (!attempt.job.grouped || hostRetriesExhausted(attempt));
}

/** One observer per eligible parent. Child observation uses the plugin context, not the parent scope. */
export function installWatchdog({ ctx, parent, config, nativeDefinition, modelGroups, logger = ctx.logger, clock = globalThis }) {
  const projections = ctx.get('sessionProjections');
  const agents = ctx.get('agents');
  const subagents = ctx.get('subagents');
  if (!projections?.snapshot || !projections?.onChanged || !agents?.get || !subagents?.namesOf) return undefined;
  const jobs = new Set();
  const pending = new Map();
  const runs = new Map();
  const children = new WeakMap();
  const sessions = new WeakMap();
  const released = new Map();
  const listeners = [];
  let closed = false;
  let parentSignal;
  let stopListeningParent;

  function onAbort(signal, callback) {
    if (!signal) return () => {};
    if (signal.aborted) callback();
    else signal.addEventListener('abort', callback, { once: true });
    return () => signal.removeEventListener('abort', callback);
  }

  function liveParent() {
    if (closed || agents.get(parent.id) !== parent || parent.ctx?.fiber?.uid === null) return false;
    try { parent.ctx?.fiber?.assertActive?.(); }
    catch { return false; }
    return true;
  }

  function valid(job) {
    return jobs.has(job) && !job.controller.signal.aborted && !parentSignal?.aborted &&
      liveParent() && readWatchdog(config).mode !== 'off';
  }

  function stopTimer(record, key) {
    if (record[key] !== undefined) clock.clearTimeout(record[key]);
    record[key] = undefined;
  }

  function report(text) {
    if (!liveParent()) return;
    try { notice(parent, text); }
    catch { logger?.warn?.('dsh-submodel: could not deliver a monitoring notice'); }
  }

  function dropChild(attempt) {
    if (attempt.child) {
      children.delete(attempt.child);
      sessions.delete(attempt.child.session);
    }
    attempt.child = undefined;
    attempt.stopListeningChild?.();
    attempt.stopListeningChild = undefined;
    attempt.signal = undefined;
  }

  function unpend(attempt) {
    const siblings = pending.get(attempt.name);
    siblings?.delete(attempt);
    if (siblings?.size === 0) pending.delete(attempt.name);
    stopTimer(attempt, 'pendingTimer');
  }

  function dropAttempt(attempt) {
    unpend(attempt);
    if (attempt.key !== undefined) runs.delete(attempt.key);
    if (released.get(attempt.id) === attempt) released.delete(attempt.id);
    dropChild(attempt);
    attempt.args = undefined;
    stopTimer(attempt, 'attemptTimer');
    stopTimer(attempt, 'releaseTimer');
    stopTimer(attempt, 'graceTimer');
  }

  function clear(job) {
    if (!jobs.delete(job)) return;
    job.stopListeningCaller?.();
    dropAttempt(job.attempt);
    if (job.previous && job.previous !== job.attempt) dropAttempt(job.previous);
    job.previous = undefined;
    job.args = undefined;
    job.controller.abort();
  }

  function scheduleAttempt(job, args, route, name) {
    const attempt = { job, route, name, args: { ...args, name }, parentSeq: parent.session.seq, status: 'pending' };
    job.attempt = attempt;
    const siblings = pending.get(name) ?? new Set();
    if (siblings.size > 0) {
      // Keep reservations until their native receipts arrive or the deadline passes.
      for (const previous of siblings) previous.ambiguous = true;
      attempt.ambiguous = true;
    }
    siblings.add(attempt);
    pending.set(name, siblings);
    attempt.pendingTimer = clock.setTimeout(() => clear(job), LIMITS.pending);
    attempt.attemptTimer = clock.setTimeout(() => {
      if (valid(job)) report(`「${name}」的用量观察已到时限。请在子代理面板查看进度。`);
      clear(job);
    }, LIMITS.attempt);
    return attempt;
  }

  function begin(args, route, tier, exec) {
    const policy = readWatchdog(config);
    if (!liveParent() || !tier || !samePair(route, route) || policy.mode === 'off' ||
        !policy.tiers.includes(tier) || exec.signal?.aborted) return undefined;
    const initial = { provider: route.provider, model: route.model };
    const candidates = modelGroups ? laterModels(modelGroups, tier, initial)
      : (readLive(config, 'fallbacks') ?? []).find(row => samePair(initial, row.primary))?.alternatives ?? [];
    const job = {
      id: shortId(), tier, policy: structuredClone(policy), initial, grouped: modelGroups !== undefined,
      candidates: structuredClone(candidates), used: 0, total: 0,
      args: structuredClone(args), controller: new AbortController(), budgetReached: false,
    };
    const name = typeof args.name === 'string' && NAME.test(args.name) && args.name !== 'lead' ? args.name : `sm-${job.id}`;
    jobs.add(job);
    const ticket = scheduleAttempt(job, args, initial, name);
    job.stopListeningCaller = onAbort(exec.signal, () => clear(job));
    return ticket;
  }

  function beginObservation(info) {
    if (!info.local || info.provider !== 'spawn' || info.parentSessionId !== parent.id) return;
    const previous = released.get(info.id);
    if (previous?.runId !== info.runId && previous) clear(previous.job);
    if (runs.has(endKey(info))) return;
    const child = agents.get(info.id);
    if (!child?.session || child.session.header?.parentSession !== parent.id) return;
    let name;
    try { name = subagents.namesOf(child).self; }
    catch { return; }
    const siblings = pending.get(name);
    if (siblings?.size !== 1) return;
    const [attempt] = siblings;
    if (attempt.ambiguous || attempt.child || !valid(attempt.job)) return;
    attempt.id = info.id;
    attempt.runId = info.runId;
    attempt.key = endKey(info);
    attempt.child = child;
    attempt.fromSeq = child.session.seq;
    runs.set(attempt.key, attempt);
    children.set(child, attempt);
    sessions.set(child.session, attempt);
  }

  function stillWorking(attempt) {
    return !attempt.waitForProgress && !attempt.cancelled && !attempt.incomplete && !attempt.routeChanged && !attempt.terminal &&
      !!attempt.child && agents.get(attempt.id) === attempt.child && attempt.child.status === 'running' &&
      attempt.signal && !attempt.signal.aborted && attempt.initialId && valid(attempt.job);
  }

  function sample(attempt) {
    if (!attempt.child) return;
    if (attempt.reportedUsage === undefined) {
      attempt.usage = undefined;
      return;
    }
    let observed;
    try { observed = sumUsage(projections.snapshot(attempt.child.session, ['tokenUsage']).values.tokenUsage); }
    catch { /* Unavailable or invalid observations cannot authorize an action. */ }
    if (observed === undefined || observed < attempt.reportedUsage) {
      attempt.usage = undefined;
      return;
    }
    attempt.peak = Math.max(attempt.peak ?? 0, observed);
    attempt.usage = attempt.peak;
    const job = attempt.job;
    const total = job.total + attempt.usage;
    if (!Number.isSafeInteger(total)) {
      attempt.usage = undefined;
      return;
    }
    if (!attempt.accepted || attempt.nudged || total < job.policy.warnTokens || !valid(job)) return;
    job.budgetReached = true;
    if (!stillWorking(attempt)) return;
    attempt.nudged = true;
    const signal = attempt.signal;
    const turn = attempt.turn;
    queueMicrotask(() => {
      if (!stillWorking(attempt) || attempt.signal !== signal || attempt.turn !== turn) return;
      attempt.noticeId = randomUUID();
      try { notice(attempt.child, REMINDER, attempt.noticeId); }
      catch {
        if (valid(job)) report(`请在子代理面板提醒「${attempt.name}」收尾。`);
        return;
      }
      attempt.status = 'nudged';
      if (job.policy.mode !== 'stop' || !stillWorking(attempt)) return;
      attempt.graceTimer = clock.setTimeout(() => {
        attempt.graceTimer = undefined;
        if (!stillWorking(attempt) || readWatchdog(config).mode !== 'stop') return;
        report(`「${attempt.name}」在宽限期后仍在进行。请在子代理面板停止。`);
      }, job.policy.graceMs);
    });
  }

  function finish(attempt, receipt) {
    if (!attempt || !jobs.has(attempt.job)) return;
    unpend(attempt);
    if (!valid(attempt.job) || attempt.ambiguous || !attempt.key || !attempt.catalogSeen ||
        receipt?.kind !== 'activation' || receipt.name !== attempt.name) {
      clear(attempt.job);
      return;
    }
    attempt.accepted = true;
    attempt.status = 'running';
    sample(attempt);
    if (attempt.ended) settle(attempt);
  }

  function routeRecorded(route) {
    try {
      const state = projections.stateOf?.(parent.session, 'subagentModelSelectionPolicy');
      return Array.isArray(state) && state.some(row => samePair(row, route));
    } catch { return false; }
  }

  function validRetry(job, candidate) {
    if (!valid(job) || job.budgetReached) return false;
    const active = readWatchdog(config);
    if (active.mode !== 'retry' || !active.tiers.includes(job.tier) || job.used > active.maxRetries ||
        job.total >= active.warnTokens) return false;
    const currentGroups = readModelGroups(config);
    if (job.grouped) {
      if (!sameGroupOrder(modelGroups, currentGroups, job.tier)) return false;
    } else {
      const currentChain = (readLive(config, 'fallbacks') ?? []).find(row => samePair(row.primary, job.initial))?.alternatives;
      if (currentGroups || candidate.provider !== job.initial.provider || !samePair(currentChain?.[job.used - 1], candidate)) return false;
    }
    if (ctx.tools.executable?.('subagent', parent) !== nativeDefinition || !routeRecorded(candidate)) return false;
    try {
      const host = ctx.get('settings')?.describe().find(row => row.ns === HOST_SELECTION_ENTRY_ID)?.value;
      return host?.enabled === true && host.allowedModels.some(row => samePair(row, candidate));
    } catch { return false; }
  }

  async function retry(job, previous, candidate) {
    const nextName = `sm-${job.id}-r${job.used}`;
    const failed = `「${previous.name}」失败。`;
    const manual = () => { if (valid(job)) report(`${failed}请在子代理面板确认是否重新派活。`); };
    try {
      if (!validRetry(job, candidate)) return manual();
      const models = await ctx.get('llm')?.listModels(candidate.provider, job.controller.signal);
      if (!models?.some(model => model.id === candidate.model) || !validRetry(job, candidate) ||
          agents.get(previous.id) !== undefined) return manual();
      const { reasoning_effort, ...original } = job.args;
      void reasoning_effort;
      // 改派不继承原档位；目标模型配置了默认档位时使用它，否则交给模型默认。
      const candidateArgs = { ...original, ...candidate };
      const configured = modelGroups ? candidateRowEffort(modelGroups, job.tier, candidate) : undefined;
      if (configured !== undefined) candidateArgs.reasoning_effort = configured;
      const attempt = scheduleAttempt(job, candidateArgs, candidate, nextName);
      const startup = new AbortController();
      const stopForwarding = onAbort(job.controller.signal, () => startup.abort());
      const id = randomUUID();
      let receipt;
      try {
        const batch = await ctx.tools.execute({ agent: parent, signal: startup.signal,
          calls: [{ id, name: 'subagent', arguments: JSON.stringify(attempt.args) }],
        });
        // Once the tool has returned, withdrawing monitoring must leave accepted work to the host.
        stopForwarding();
        const result = batch.results.find(entry => entry.callId === id)?.result;
        if (result && !result.isError) receipt = result.value;
        if (valid(job)) {
          if (receipt?.kind === 'activation' && receipt.name === nextName) report(`${failed}已接受改派「${nextName}」。`);
          else manual();
        }
      } catch {
        if (valid(job)) report(`${failed}未收到改派确认。请先在子代理面板查看新任务是否已经启动。`);
      } finally {
        stopForwarding();
        finish(attempt, receipt);
      }
    } catch {
      manual();
    } finally {
      if (job.attempt === previous) clear(job);
    }
  }

  function settle(attempt) {
    if (!attempt.accepted || !attempt.ended || attempt.status === 'terminal') return;
    attempt.status = 'terminal';
    const job = attempt.job;
    const candidate = job.candidates[job.used];
    if (!valid(job) || !matchesEnd(attempt) || job.policy.mode !== 'retry' || job.budgetReached ||
        job.used >= job.policy.maxRetries || !candidate) {
      clear(job);
      return;
    }
    job.total += attempt.usage;
    if (!Number.isSafeInteger(job.total) || job.total >= job.policy.warnTokens) {
      clear(job);
      return;
    }
    job.used++;
    dropAttempt(attempt);
    // Keep only the prior generation id during the async decision.
    job.previous = attempt;
    released.set(attempt.id, attempt);
    attempt.releaseTimer = clock.setTimeout(() => clear(job), LIMITS.release);
    void retry(job, attempt, candidate).finally(() => {
      if (job.previous === attempt) job.previous = undefined;
      dropAttempt(attempt);
    });
  }

  function finishObservation(info) {
    const attempt = runs.get(endKey(info));
    if (!attempt || attempt.ended || info.parentSessionId !== parent.id) return;
    if (attempt.child !== undefined) attempt.incomplete = true;
    attempt.ended = true;
    stopTimer(attempt, 'graceTimer');
    attempt.terminal = { ...attempt.terminal, stopReason: info.stopReason };
    if (includesContent(info.lastAssistantMessage)) attempt.hasOutput = true;
    settle(attempt);
  }

  function onSessionEvent(session, event) {
    if (session === parent.session && event.type === 'subagent/catalog') {
      for (const attempt of pending.get(event.data.name) ?? []) {
        if (attempt.id === event.data.childId && event.seq >= attempt.parentSeq) attempt.catalogSeen = true;
      }
    }
    const attempt = sessions.get(session);
    if (!attempt || event.seq < attempt.fromSeq) return;
    if (attempt.job.grouped && (event.type === 'llm/retry' || event.type === 'llm/retry-started')) {
      observeRetry(attempt, event);
    }
    if (event.type === 'step/start' || event.type === 'llm/retry-started') {
      attempt.waitForProgress = false;
      sample(attempt);
    }
    if (event.type === 'tool/call') attempt.hasOutput = true;
    if (event.type === 'request/header' && !samePair(attempt.route, event.data.header?.config)) attempt.routeChanged = true;
    if (event.type === 'request/context' && !samePair(attempt.route, event.data)) attempt.routeChanged = true;
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      observeAssistant(attempt, event);
      sample(attempt);
    }
    if (event.type === 'turn/end') {
      const { turn, reason } = event.data;
      stopTimer(attempt, 'graceTimer');
      attempt.terminal = { turn, code: reason.kind === 'error' ? reason.error?.code : undefined };
    }
  }

  function onDispose({ agent }) {
    if (agent === parent) { dispose(); return; }
    const attempt = children.get(agent);
    if (!attempt) return;
    sample(attempt);
    if (attempt.signal?.aborted || !attempt.terminal) attempt.cancelled = true;
    stopTimer(attempt, 'graceTimer');
    dropChild(attempt);
    released.set(agent.id, attempt);
    attempt.releaseTimer = clock.setTimeout(() => clear(attempt.job), LIMITS.release);
  }

  function dispose() {
    if (closed) return;
    closed = true;
    for (const job of jobs) clear(job);
    stopListeningParent?.();
    parentSignal = undefined;
    for (const disposeListener of listeners.splice(0).reverse()) disposeListener?.();
  }

  function listen(context, event, callback, options) {
    listeners.push(context.on(event, callback, options));
  }
  listen(parent.ctx, 'subagent/start', beginObservation);
  listen(parent.ctx, 'subagent/end', finishObservation);
  listen(ctx, 'session/event', onSessionEvent, { global: true });
  listen(ctx, 'agent/disposed', onDispose, { global: true });
  listen(ctx, 'settings/document-updated', ns => {
    if (ns === CONFIG_ENTRY && readWatchdog(config).mode === 'off') for (const job of jobs) clear(job);
  });
  listen(ctx, 'agent/inbox/inserted', ({ agent, message }) => {
    const attempt = children.get(agent);
    if (!attempt || message.id === attempt.noticeId) return;
    if (attempt.initialId === undefined && message.source?.kind === 'user' && !message.source.rpcId) attempt.initialId = message.id;
    else clear(attempt.job);
  }, { global: true });
  listen(ctx, 'agent/pre-step', ({ agent, turn, step, signal, modelSelection }, next) => {
    if (agent === parent && parentSignal !== signal) {
      stopListeningParent?.();
      parentSignal = signal;
      stopListeningParent = onAbort(signal, () => { for (const job of jobs) clear(job); });
    }
    const attempt = children.get(agent);
    if (attempt) {
      if (attempt.turn !== undefined && attempt.turn !== turn) clear(attempt.job);
      else {
        attempt.turn = turn;
        if (attempt.step !== step) attempt.hostRetry = undefined;
        attempt.step = step;
        if (!samePair(attempt.route, modelSelection)) attempt.routeChanged = true;
        if (attempt.signal !== signal) {
          attempt.stopListeningChild?.();
          attempt.signal = signal;
          attempt.stopListeningChild = onAbort(signal, () => clear(attempt.job));
        }
      }
    }
    return next();
  }, { global: true });
  listen(ctx, 'agent/request-error', ({ agent, turn, step, provider, failure, retryPolicy }, next) => {
    const attempt = children.get(agent);
    if (attempt) {
      if (provider !== attempt.route.provider) attempt.routeChanged = true;
      const retryLimit = retryPolicy?.mode === 'normal' && retryPolicy.retryableCodes?.includes(failure?.code)
        ? retryPolicy.maxRetries : undefined;
      attempt.failure = { turn, step, code: failure?.code, retryLimit };
    }
    return next();
  }, { global: true });
  listeners.push(projections.onChanged((session, key) => {
    const attempt = sessions.get(session);
    if (key === 'tokenUsage' && attempt) sample(attempt);
  }));

  return { begin, finish, dispose };
}
