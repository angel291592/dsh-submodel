import z from '@deepseek-ai/schemastery';
import { ROUTING_ORDER, routeKey } from './policy.js';

export const CONFIG_ENTRY = 'submodel';
export const SETUP_FIELDS = Object.freeze(['modelGroups', 'economyRoutes']);
export const WATCHDOG_DEFAULTS = Object.freeze({
  mode: 'off', tiers: Object.freeze(['expert']), warnTokens: 100_000, graceMs: 60_000, maxRetries: 1,
});

/** The host projects and then serializes the form schema again. Keep runtime-only validation off the wire. */
function validatedLiveField(shape, defaults, validate) {
  const form = shape.default(defaults).volatile();
  const field = z.transform(shape, validate, true).default(defaults).volatile();
  Object.defineProperty(field, 'toJSON', { value: form.toJSON.bind(form) });
  return field;
}

const pair = z.object({
  provider: z.string().pattern(/\S/u).required(),
  model: z.string().pattern(/\S/u).required(),
}).required();

const fallbacks = validatedLiveField(z.array(z.object({
  primary: pair,
  alternatives: z.array(pair).required(),
}).required()), [], (rows) => {
  const primaries = new Set();
  for (const { primary, alternatives } of rows) {
    const key = routeKey(primary);
    if (primaries.has(key)) throw new Error('Each primary model can have only one fallback list.');
    primaries.add(key);
    const seen = new Set([key]);
    for (const alternative of alternatives) {
      const candidate = routeKey(alternative);
      if (seen.has(candidate)) throw new Error('A fallback list cannot contain its primary model or a repeated model.');
      seen.add(candidate);
    }
  }
  return rows;
});

// The explicit legacy value survives the host's two form serializations and
// distinguishes older settings from two deliberately empty ordered groups.
const modelRow = z.object({
  provider: z.string().pattern(/^[^\p{Cc}]*[^\p{Cc}\s][^\p{Cc}]*$/u).required(),
  model: z.string().pattern(/^[^\p{Cc}]*[^\p{Cc}\s][^\p{Cc}]*$/u).required(),
  note: z.string().max(120).default(''),
  reasoningEffort: z.string().default(''),
}).required();
const modelGroups = validatedLiveField(z.union(['legacy', z.object({
  executors: z.array(modelRow).required(),
  experts: z.array(modelRow).required(),
}).required()]), 'legacy', (groups) => {
  if (groups === 'legacy') return groups;
  for (const rows of [groups.executors, groups.experts]) {
    if (new Set(rows.map(routeKey)).size !== rows.length) throw new Error('A model may appear only once in each group.');
  }
  return groups;
});

const watchdog = validatedLiveField(z.object({
  mode: z.union(['off', 'notify', 'stop', 'retry']).default(WATCHDOG_DEFAULTS.mode),
  tiers: z.array(z.union(['executor', 'expert']).required()).min(1).max(2).default(WATCHDOG_DEFAULTS.tiers),
  warnTokens: z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(WATCHDOG_DEFAULTS.warnTokens),
  graceMs: z.number().min(1_000).max(600_000).step(1).default(WATCHDOG_DEFAULTS.graceMs),
  maxRetries: z.number().min(0).max(2).step(1).default(WATCHDOG_DEFAULTS.maxRetries),
}), WATCHDOG_DEFAULTS, (value) => {
  if (new Set(value.tiers).size !== value.tiers.length) throw new Error('Each monitored role must be unique.');
  return value;
});

export const Config = z.object({
  enabled: z.boolean().default(true),
  preset: z.string().default('standard'),
  teamFit: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  toolName: z.string().default('list_subagent_models'),
  order: z.number().default(ROUTING_ORDER),
  executor: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default('max'),
  }).default({ provider: '', model: '', reasoningEffort: 'max' }).volatile(),
  experts: z.array(z.object({
    label: z.string(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().default('max'),
  })).default([]).volatile(),
  texts: z.object({
    economize: z.string().default(''),
    boss: z.string().default(''),
    child: z.string().default(''),
  }).default({ economize: '', boss: '', child: '' }),
  guardNativeSubagent: z.boolean().default(true),
  autoConfigure: z.boolean().default(true),
  economyRoutes: z.array(z.object({
    provider: z.string().default(''),
    model: z.string().min(1),
  })).default([]).volatile(),
  fallbacks,
  modelGroups,
  watchdog,
});

/** Cordis uses references; direct callers can pass ordinary config values. */
export function readLive(config, field) {
  const value = config?.[field];
  return typeof value?.get === 'function' ? value.get() : value;
}

export function readModelGroups(config) {
  const groups = readLive(config, 'modelGroups');
  return groups && typeof groups === 'object' && !Array.isArray(groups) &&
    Array.isArray(groups.executors) && Array.isArray(groups.experts) ? groups : undefined;
}

export function readExecutor(config, groups = readModelGroups(config)) {
  const executor = groups ? groups.executors[0] : readLive(config, 'executor');
  return {
    provider: executor?.provider ?? '',
    model: executor?.model ?? '',
    reasoningEffort: executor?.reasoningEffort ?? (groups ? '' : 'max'),
  };
}

export function executorConfigured(config) {
  const { provider, model } = readExecutor(config);
  return provider !== '' && model !== '';
}

export function readWatchdog(config) {
  return { ...WATCHDOG_DEFAULTS, ...readLive(config, 'watchdog') };
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** Body, guard and delegation use a single detached policy for the lifetime of a live Agent. */
export function routingSnapshot(config) {
  const modelGroups = readModelGroups(config);
  const experts = modelGroups?.experts ?? readLive(config, 'experts');
  const economyRoutes = readLive(config, 'economyRoutes');
  const snapshot = {
    modelGroups,
    executor: readExecutor(config, modelGroups),
    experts: Array.isArray(experts) ? experts : [],
    economyRoutes: Array.isArray(economyRoutes) ? economyRoutes.filter(row =>
      row && typeof row.model === 'string' && row.model !== '',
    ).map(row => ({ provider: typeof row.provider === 'string' ? row.provider : '', model: row.model })) : [],
    texts: config?.texts ?? {},
    guardNativeSubagent: config?.guardNativeSubagent !== false,
  };
  return freezeTree(structuredClone(snapshot));
}

/** One ordered mutation per namespace, common to a UI save and the setup tool. */
export function settingOps(fields, values) {
  return fields.map(field => ({ op: 'set', path: [field], value: values[field] }));
}
