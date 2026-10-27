import {
  effectiveInstructionProfile,
  type PlanningLimits,
  resolveTranslationSettings,
  SOURCE_CHARACTER_PRESETS,
  type TranslateRequest,
} from '@ai-translator-for-contentful/protocol';
import type { DialogAppSDK } from '@contentful/app-sdk';
import { Button, Heading, Paragraph, Select, Spinner } from '@contentful/f36-components';
import type { Document } from '@contentful/rich-text-types';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { richTextReviewValidation } from '../richtext/editor';
import { type Dependency, planTasks, type Task, type TaskResult } from './batch';
import type { DialogChoice } from './choices';
import { boundContext, type ContextCandidate } from './context';
import { ChooseScreen } from './dialog/ChooseScreen';
import { ExpandView, expandableType } from './dialog/ExpandView';
import {
  applySummary,
  chooseSuggestionsInTab,
  dependenciesCurrent,
  fieldSourceProblem,
  isCurrent,
  launchedField,
  localeName,
  type Review,
  restoreGeneratedSuggestion,
  reviewFromResult,
  selectableFields,
  suggestionWarning,
  taskDefinition,
  unappliedOutcome,
  usableReview,
  warningApproved,
} from './dialog/model';
import { ReviewScreen } from './dialog/ReviewScreen';
import { RichTextExpand } from './dialog/RichTextExpand';
import { changedValues, type EditorSnapshot } from './editor-snapshot';
import {
  functionHealthMatches,
  functionModelSelection,
  functionProviderHost,
  functionReadinessError,
} from './function-config';
import { type FunctionHealth, functionHealth, functionTranslate } from './function-transport';
import { receiveSnapshotSession, requestCurrentSnapshot } from './live-snapshot';
import { type FieldSource, PlanError, type PlanOptions, planRetry, planRun, type RunPlan } from './planner';
import {
  initialChoice,
  initialTargets,
  readPreference,
  readTargetPreference,
  savePreference,
  saveTargetPreference,
} from './preference';
import {
  executeRun,
  failedGroups,
  keptRanges,
  type RunState,
  retryRun,
  smallerRetryApplies,
  startRun,
  taskParts,
  taskResult,
} from './run';
import { type EntryHit, loadSavedEntry, type SavedEntry, searchSavedEntries } from './saved-context';
import { connectionErrorMessage, dialogRelayChoices } from './setup-model';
import { isConfigured } from './sidebar-model';
import { signedHealth, signedTranslate } from './signed';
import type { Params } from './transport-config';

type Accepted = {
  entryId: string;
  fieldId: string;
  kind: 'text' | 'array' | 'richText';
  sourceLocale: string;
  targetLocale: string;
  sourceSnapshot: unknown;
  targetSnapshot: unknown;
  // Every sibling and context value the suggestion's requests sent.
  dependencies: Dependency[];
  suggestion?: string | string[] | Document;
  warningApproved?: boolean;
};
type DialogResult = {
  choice: 'keep' | 'suggestion';
  accepted?: Accepted[];
  outcomes: { key: string; status: string; detail?: string }[];
};
// Progress of a run: the request being sent and the suggestions ready.
export type RunProgress = { request: number; requests: number; ready: number; total: number; running: string[] };
// A retry waiting for the editor to start it.
export type PendingRetry =
  | { keys: string[]; smaller: boolean; plan: RunPlan }
  | { keys: string[]; smaller: boolean; message: string };
type BackendPolicy = { limits: PlanningLimits };

const contextValue = (value: unknown) =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every(item => typeof item === 'string')) ||
  Boolean(value && typeof value === 'object' && 'nodeType' in value && value.nodeType === 'document');
const contextKey = (item: Pick<ContextCandidate, 'entryId' | 'fieldId' | 'locale' | 'provenance'>) =>
  `${item.provenance}:${item.entryId}:${item.fieldId}:${item.locale}`;

export function Dialog({ sdk }: { sdk: DialogAppSDK }) {
  const config = useMemo(() => (sdk.parameters.installation ?? {}) as Params, [sdk]);
  const profileState = useMemo(() => {
    try {
      return { profile: effectiveInstructionProfile(config) };
    } catch (error) {
      return { profile: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }, [config]);
  const profile = profileState.profile;
  const localeNames = sdk.locales.names as Record<string, string>;
  const usableProvider = (provider: TaskResult['provider']) => provider === 'openai-compatible';
  const invocation = sdk.parameters.invocation as
    | { entryId?: unknown; contentTypeId?: unknown; sessionId?: unknown; fieldId?: unknown; sourceLocale?: unknown }
    | undefined;
  const sessionId = typeof invocation?.sessionId === 'string' ? invocation.sessionId : undefined;
  const liveUpdatesAvailable = Boolean(sessionId && typeof BroadcastChannel !== 'undefined');
  const [snapshot, setSnapshot] = useState<EditorSnapshot>();
  const snapshotRef = useRef<EditorSnapshot | undefined>(undefined);
  const [syncing, setSyncing] = useState(liveUpdatesAvailable);
  const preferenceScope = `${sdk.ids.space}:${sdk.ids.environment}:${sdk.ids.user}`;
  const sourcePreferenceKey = `ai-translator-for-contentful:source:${preferenceScope}`;
  const targetPreferenceKey = `ai-translator-for-contentful:targets:${preferenceScope}`;
  // The two transports name choices differently, so each keeps its own default.
  const choicePreferenceKey = `ai-translator-for-contentful:choice:${config.transport === 'function' ? 'function' : 'custom'}:${preferenceScope}`;
  const sourcePreference = useMemo(() => readPreference(sourcePreferenceKey), [sourcePreferenceKey]);
  const choicePreference = useMemo(() => readPreference(choicePreferenceKey), [choicePreferenceKey]);
  const targetPreference = useMemo(() => readTargetPreference(targetPreferenceKey), [targetPreferenceKey]);
  const [source, setSource] = useState('');
  const [saveDefault, setSaveDefault] = useState(false);
  const [saveTargetDefault, setSaveTargetDefault] = useState(false);
  const [fields, setFields] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const targetsInitialized = useRef(false);
  const [runGuidance, setRunGuidance] = useState('');
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [instructionStatus, setInstructionStatus] = useState<'ready' | 'mismatch'>('ready');
  const [policy, setPolicy] = useState<BackendPolicy>();
  const [contextKeys, setContextKeys] = useState<string[]>([]);
  const [savedEntries, setSavedEntries] = useState<Record<string, SavedEntry>>({});
  const [entrySearch, setEntrySearch] = useState('');
  const [entryHits, setEntryHits] = useState<EntryHit[]>([]);
  const [contextStatus, setContextStatus] = useState('');
  const [previewRevision, setPreviewRevision] = useState(0);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const reviewsRef = useRef(reviews);
  reviewsRef.current = reviews;
  const [screen, setScreen] = useState<'choose' | 'review'>('choose');
  const [activeTab, setActiveTab] = useState('');
  const [expandedKey, setExpandedKey] = useState<string>();
  // The editor's show or hide choices for the review's source column and
  // each tab's "now" column.
  const [sourceOpen, setSourceOpen] = useState(true);
  const [nowOpen, setNowOpen] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState('');
  const [functionStatus, setFunctionStatus] = useState<'checking' | 'ready' | 'failed'>('checking');
  const [functionProblem, setFunctionProblem] = useState('Checking the saved Function connection…');
  const [relayStatus, setRelayStatus] = useState<'checking' | 'ready' | 'failed'>('checking');
  const [relayProblem, setRelayProblem] = useState('');
  // The choices the installation offers, confirmed by health, and the one this
  // dialog uses. It starts at the installation default and is never saved.
  const [choices, setChoices] = useState<DialogChoice[]>([]);
  const [choiceKey, setChoiceKey] = useState('');
  const [saveChoiceDefault, setSaveChoiceDefault] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  // The frozen run: its tasks, planning inputs and request attempts.
  const [run, setRun] = useState<RunState>({ requests: [], parts: [] });
  const runRef = useRef(run);
  const runTasksRef = useRef<Task[]>([]);
  const runOptionsRef = useRef<PlanOptions | undefined>(undefined);
  const sourcesRef = useRef(new Map<string, FieldSource>());
  const [pendingRetry, setPendingRetry] = useState<PendingRetry>();
  const controllerRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);

  useEffect(() => {
    if (!sessionId || typeof BroadcastChannel === 'undefined') return;
    return receiveSnapshotSession(sessionId, next => {
      if (!next || next.entryId !== invocation?.entryId || next.contentTypeId !== invocation?.contentTypeId) return;
      const first = !snapshotRef.current;
      const changed = snapshotRef.current ? changedValues(snapshotRef.current, next) : [];
      snapshotRef.current = next;
      setSnapshot(next);
      setSyncing(false);
      const launched = launchedField(next, invocation?.fieldId, invocation?.sourceLocale);
      if (first && launched) setFields([launched.field.id]);
      setSource(
        value =>
          value ||
          (launched
            ? launched.locale
            : next.focusedLocale && next.locales.includes(next.focusedLocale)
              ? next.focusedLocale
              : sourcePreference.value && next.locales.includes(sourcePreference.value)
                ? sourcePreference.value
                : next.defaultLocale),
      );
      if (changed.length) setStatus('Editor values changed. Review affected suggestions before applying.');
    });
  }, [
    sessionId,
    invocation?.entryId,
    invocation?.contentTypeId,
    invocation?.fieldId,
    invocation?.sourceLocale,
    sourcePreference.value,
  ]);
  const localesKey = snapshot?.locales.join('\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the locale list changes, not on every live editor value.
  useEffect(() => {
    if (!snapshot || !source) return;
    setTargets(current => {
      if (!targetsInitialized.current) return initialTargets(snapshot.locales, source, targetPreference.value);
      const available = snapshot.locales.filter(locale => locale !== source);
      return available.length === 1 ? available : current.filter(locale => available.includes(locale));
    });
    targetsInitialized.current = true;
  }, [source, localesKey, targetPreference.value]);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    if (config.transport !== 'function' || functionReadinessError(config)) return;
    let cancelled = false;
    void functionHealth(sdk)
      .then((result: FunctionHealth) => {
        if (cancelled) return;
        if (functionHealthMatches(result, config)) {
          const saved = functionModelSelection(config);
          const host = functionProviderHost(config) ?? '';
          const offered = saved.choices.map(choice => ({
            key: choice.model,
            model: choice.model,
            host,
            timeoutSeconds: result.timeoutSeconds,
            ...(choice.translationSettings ? { translationSettings: choice.translationSettings } : {}),
          }));
          setChoices(offered);
          setChoiceKey(initialChoice(offered, saved.defaultModel ?? '', choicePreference.value));
          setPolicy({ limits: result.limits });
          setFunctionStatus('ready');
          if (profile) setInstructionStatus(result.profileRevision === profile.revision ? 'ready' : 'mismatch');
        } else {
          setFunctionProblem('The saved Function settings changed. Ask a space admin to check app configuration.');
          setFunctionStatus('failed');
        }
      })
      .catch(error => {
        if (cancelled) return;
        setFunctionProblem(error instanceof Error ? error.message : 'The Function could not be checked.');
        setFunctionStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, config, profile, choicePreference.value]);
  // Generation waits for signed health: it lists the providers this space may
  // use and confirms the saved default is still one of them.
  useEffect(() => {
    if (config.transport === 'function' || !config.backendUrl || !isConfigured(config)) return;
    const backendUrl = config.backendUrl;
    let cancelled = false;
    void signedHealth(sdk, backendUrl)
      .then(result => {
        if (cancelled) return;
        const start = dialogRelayChoices(result, config);
        if ('problem' in start) {
          setRelayProblem(start.problem);
          setRelayStatus('failed');
          return;
        }
        setChoices(start.choices);
        setChoiceKey(initialChoice(start.choices, start.defaultKey, choicePreference.value));
        setPolicy({ limits: result.limits });
        setRelayStatus('ready');
      })
      .catch(error => {
        if (cancelled) return;
        setRelayProblem(connectionErrorMessage(error, 'custom').text);
        setRelayStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, config, choicePreference.value]);

  useEffect(() => {
    if (entrySearch.trim().length < 2) {
      setEntryHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchSavedEntries(sdk, entrySearch)
        .then(hits => {
          if (!cancelled) setEntryHits(hits.filter(hit => hit.id !== snapshot?.entryId));
        })
        .catch(() => {
          if (!cancelled) setContextStatus('Could not search entries. Try again.');
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [entrySearch, sdk, snapshot?.entryId]);

  function resetReview() {
    epochRef.current++;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setGenerating(false);
    setReviews({});
    const empty = { requests: [], parts: [] };
    runRef.current = empty;
    setRun(empty);
    setPendingRetry(undefined);
    setScreen('choose');
    setExpandedKey(undefined);
    setSourceOpen(true);
    setNowOpen({});
    setStatus('');
  }
  function toggle(list: string[], setList: (value: string[]) => void, value: string) {
    resetReview();
    setList(list.includes(value) ? list.filter(item => item !== value) : [...list, value]);
  }
  const tasks = useMemo(
    () => (snapshot ? planTasks(snapshot, fields, source, targets) : []),
    [snapshot, fields, source, targets],
  );
  const eligibleFields = useMemo(() => (snapshot ? selectableFields(snapshot, source) : []), [snapshot, source]);
  const launch = snapshot ? launchedField(snapshot, invocation?.fieldId, invocation?.sourceLocale) : undefined;
  const contextCandidates = useMemo(() => {
    if (!snapshot) return [];
    const items: ContextCandidate[] = [];
    for (const field of snapshot.definitions) {
      if (!field.localized || field.disabled || field.omitted || field.deleted) continue;
      for (const locale of snapshot.locales) {
        const rawValue = snapshot.fields[field.id]?.[locale];
        if (contextValue(rawValue))
          items.push({
            entryId: snapshot.entryId,
            fieldId: field.id,
            fieldName: field.name,
            locale,
            provenance: 'current-editor',
            rawValue,
          });
      }
    }
    for (const entry of Object.values(savedEntries))
      for (const field of entry.definitions) {
        if (!field.localized || field.disabled || field.omitted || field.deleted) continue;
        for (const locale of snapshot.locales) {
          const rawValue = entry.fields[field.id]?.[locale];
          if (contextValue(rawValue))
            items.push({
              entryId: entry.id,
              fieldId: field.id,
              fieldName: field.name,
              locale,
              provenance: 'saved-entry',
              rawValue,
              savedVersion: entry.version,
            });
        }
      }
    return items;
  }, [snapshot, savedEntries]);
  const selectedContext = useMemo(
    () =>
      contextKeys
        .map(key => contextCandidates.find(item => contextKey(item) === key))
        .filter((item): item is ContextCandidate => Boolean(item)),
    [contextKeys, contextCandidates],
  );
  const choice = choices.find(item => item.key === choiceKey);
  const model = choice?.model ?? '';
  const relayAlias = config.transport === 'function' ? undefined : choice?.alias;
  const settings = useMemo(
    () =>
      policy && choice
        ? resolveTranslationSettings(
            choice.translationSettings,
            SOURCE_CHARACTER_PRESETS[config.transport === 'function' ? 'function' : 'custom'],
          )
        : undefined,
    [policy, choice, config.transport],
  );
  const contextResult = useMemo(() => {
    if (selectedContext.length !== contextKeys.length)
      return { items: [], error: 'A selected context value is no longer available. Remove it before translating.' };
    if (!settings) return { items: [] };
    try {
      return {
        items: boundContext(selectedContext, {
          maxFields: settings.contextMaxFields,
          fieldCharacters: settings.contextFieldCharacters,
          totalCharacters: settings.contextTotalCharacters,
        }).items,
      };
    } catch (error) {
      return { items: [], error: error instanceof Error ? error.message : String(error) };
    }
  }, [selectedContext, contextKeys, settings]);
  const planOptions = useMemo((): PlanOptions | undefined => {
    if (!profile || !policy || !settings || !model) return undefined;
    return {
      settings,
      limits: policy.limits,
      model,
      profile,
      runGuidance,
      variableValues,
      availableLocales: snapshot?.locales ?? [],
      explicitContext: selectedContext,
      envelope: (request: TranslateRequest) => (relayAlias === undefined ? request : { provider: relayAlias, request }),
      id: () => crypto.randomUUID(),
      outputAllowance: config.transport === 'function' ? config.functionMaxCompletionTokens : choice?.outputAllowance,
    };
  }, [
    profile,
    policy,
    settings,
    model,
    runGuidance,
    variableValues,
    snapshot?.locales,
    selectedContext,
    relayAlias,
    choice?.outputAllowance,
    config.transport,
    config.functionMaxCompletionTokens,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewRevision issues fresh request IDs after each run.
  const planResult = useMemo((): { plan?: RunPlan; error?: string } => {
    if (!planOptions || !tasks.length) return {};
    if (contextResult.error) return { error: contextResult.error };
    try {
      return { plan: planRun(tasks, planOptions) };
    } catch (error) {
      return {
        error:
          error instanceof PlanError || error instanceof Error ? error.message : 'The requests could not be planned.',
      };
    }
  }, [tasks, planOptions, contextResult.error, previewRevision]);
  const functionConfigError = config.transport === 'function' ? functionReadinessError(config) : undefined;
  const configured =
    config.transport === 'function'
      ? !functionConfigError && functionStatus === 'ready' && Boolean(choice)
      : Boolean(config.backendUrl && relayStatus === 'ready' && relayAlias);
  const canTranslate =
    !syncing &&
    liveUpdatesAvailable &&
    !generating &&
    configured &&
    instructionStatus === 'ready' &&
    tasks.length > 0 &&
    !contextResult.error &&
    !planResult.error &&
    Boolean(planResult.plan?.requests.length);
  const runTasks = screen === 'review' ? runTasksRef.current : tasks;
  const summary = applySummary(runTasks, reviews, snapshot, usableProvider, profile?.revision);
  const progress = useMemo((): RunProgress | undefined => {
    if (!run.requests.length) return undefined;
    const running = run.requests.findIndex(request => request.status === 'running');
    const total = runTasksRef.current.length;
    const ready = runTasksRef.current.filter(task => reviews[task.key]?.status === 'ready').length;
    return {
      request: running < 0 ? run.requests.filter(request => request.status !== 'pending').length : running + 1,
      requests: run.requests.length,
      ready,
      total,
      running:
        running < 0
          ? []
          : [...new Set(run.parts.filter(part => part.request === running).map(part => part.part.task.key))],
    };
  }, [run, reviews]);

  // Turns run attempts into reviews. A task's review is replaced only when
  // its attempts change, so edits to an unchanged suggestion survive.
  function publish(state: RunState) {
    setReviews(current => {
      const next = { ...current };
      for (const task of runTasksRef.current) {
        const attempt = taskParts(state, task.key)
          .map(part => `${part.request}:${part.outcome.status}`)
          .join(',');
        if (current[task.key]?.attempt === attempt) continue;
        const result = taskResult(state, task, sourcesRef.current);
        if (!result) delete next[task.key];
        else
          next[task.key] = {
            ...reviewFromResult(result, snapshotRef.current, usableProvider, profile?.revision),
            attempt,
          };
      }
      return next;
    });
  }

  async function execute(state: RunState) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const epoch = ++epochRef.current;
    runRef.current = state;
    setRun(state);
    publish(state);
    setGenerating(true);
    setStatus('Translating…');
    const alias = relayAlias;
    try {
      await executeRun(
        () => runRef.current,
        next => {
          // A reply after cancel, reset or a newer run is ignored.
          if (epochRef.current !== epoch) return;
          runRef.current = next;
          setRun(next);
          publish(next);
        },
        (request, signal) => {
          if (config.transport === 'function') return functionTranslate(sdk, request, signal);
          if (!config.backendUrl || !alias) throw new Error('The relay URL is not configured.');
          return signedTranslate(sdk, config.backendUrl, alias, request, signal);
        },
        controller.signal,
        dependencies => dependenciesCurrent(dependencies, snapshotRef.current),
      );
      if (epochRef.current === epoch)
        setStatus(controller.signal.aborted ? 'Stopped. Completed suggestions remain available.' : '');
    } finally {
      if (epochRef.current === epoch) {
        setGenerating(false);
        controllerRef.current = null;
        setPreviewRevision(value => value + 1);
      }
    }
  }

  async function generate() {
    if (!snapshot || !canTranslate || !sessionId || !planResult.plan || !planOptions) return;
    const plan = planResult.plan;
    const startEpoch = epochRef.current;
    setScreen('review');
    // Keep the open tab only while this run still translates into it.
    setActiveTab(value => (value && targets.includes(value) ? value : targets[0]));
    setStatus('Reading the latest editor values…');
    try {
      // The previewed requests are sent only if every value they froze is
      // still current; otherwise the editor reviews and plans again.
      const fresh = await requestCurrentSnapshot(sessionId);
      if (epochRef.current !== startEpoch) return;
      if (
        fresh.entryId !== snapshot.entryId ||
        fresh.contentTypeId !== snapshot.contentTypeId ||
        tasks.some(task => !isCurrent(task, fresh)) ||
        plan.requests.some(request => !dependenciesCurrent(request.dependencies, fresh))
      ) {
        snapshotRef.current = fresh;
        setSnapshot(fresh);
        setStatus('Editor values changed. Review the latest values and translate again.');
        setScreen('choose');
        return;
      }
    } catch {
      if (epochRef.current !== startEpoch) return;
      setStatus('Could not read current editor values. Close and reopen AI Translator.');
      return;
    }
    runTasksRef.current = tasks;
    runOptionsRef.current = planOptions;
    sourcesRef.current = new Map();
    setReviews({});
    setPendingRetry(undefined);
    await execute(startRun(plan));
  }

  // Previews a retry of the tasks' failed work for the editor to start.
  function prepareRetry(keys: string[], smaller: boolean) {
    const options = runOptionsRef.current;
    if (!options || generating) return;
    try {
      const plan = planRetry(
        runTasksRef.current,
        { ...options, id: () => crypto.randomUUID() },
        failedGroups(runRef.current, keys, sourcesRef.current),
        smaller,
        keptRanges(runRef.current, keys, sourcesRef.current),
      );
      setPendingRetry(plan.unavailable ? { keys, smaller, message: plan.unavailable } : { keys, smaller, plan });
    } catch (error) {
      setPendingRetry({ keys, smaller, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function startRetry() {
    if (!pendingRetry || !('plan' in pendingRetry) || generating) return;
    const { keys, plan } = pendingRetry;
    setPendingRetry(undefined);
    await execute(retryRun(runRef.current, keys, plan, sourcesRef.current));
  }

  function toggleContext(key: string) {
    resetReview();
    setContextKeys(value => (value.includes(key) ? value.filter(item => item !== key) : [...value, key]));
  }
  async function addSavedEntry(entryId: string) {
    setEntrySearch('');
    setContextStatus('Loading saved entry…');
    try {
      const entry = await loadSavedEntry(sdk, entryId);
      setSavedEntries(value => ({ ...value, [entry.id]: entry }));
      setContextStatus(`Loaded ${entry.definitions.length} fields. Choose a field below to add context.`);
    } catch {
      setContextStatus('Could not load that entry. Search again.');
    }
  }
  function updateReview(key: string, update: Partial<Review>) {
    setReviews(value => ({ ...value, [key]: { ...value[key], ...update } }));
  }
  function updateRichSuggestion(review: Review, suggestion: Document) {
    const validation = review.task.definition
      ? richTextReviewValidation(review.task.sourceSnapshot, suggestion, review.task.definition)
      : { error: 'Missing Rich Text field definition' };
    updateReview(review.task.key, {
      suggestion,
      detail: undefined,
      approvedJson: undefined,
      choice: validation.error || validation.warning ? 'keep' : review.choice,
    });
  }
  function approveWarning(review: Review) {
    setReviews(value => {
      const current = value[review.task.key];
      if (!current || !suggestionWarning(current)) return value;
      return {
        ...value,
        [review.task.key]: {
          ...current,
          approvedJson: JSON.stringify(current.suggestion),
          choice: 'suggestion',
        },
      };
    });
  }
  function restoreSuggestion(review: Review) {
    setReviews(value => {
      const current = value[review.task.key];
      return current
        ? {
            ...value,
            [review.task.key]: restoreGeneratedSuggestion(
              current,
              snapshotRef.current,
              usableProvider,
              profile?.revision,
            ),
          }
        : value;
    });
  }
  async function closeWithChoices() {
    if (!sessionId || !snapshot || applying || generating) return;
    setApplying(true);
    try {
      if (profile && config.transport === 'function') {
        let current: Awaited<ReturnType<typeof functionHealth>>;
        try {
          current = await functionHealth(sdk);
        } catch (error) {
          setStatus(
            `Could not confirm the Function’s settings before applying. ${error instanceof Error ? error.message : 'Try Apply again.'}`,
          );
          return;
        }
        if (current.profileRevision !== profile.revision) {
          setStatus(
            'The saved instruction profile changed. Close and reopen the translator before applying a suggestion.',
          );
          return;
        }
      }
      // Native field editors debounce their last change. Let it settle before
      // reading the review state that will be sent back to the sidebar.
      await new Promise(resolve => setTimeout(resolve, 650));
      const fresh = await requestCurrentSnapshot(sessionId);
      if (fresh.entryId !== snapshot.entryId || fresh.contentTypeId !== snapshot.contentTypeId) {
        setStatus('The entry changed. Close and reopen AI Translator.');
        return;
      }
      snapshotRef.current = fresh;
      setSnapshot(fresh);
      const latestReviews = reviewsRef.current;
      const valid = applySummary(runTasksRef.current, latestReviews, fresh, usableProvider, profile?.revision);
      if (valid.count === 0) {
        setStatus('Editor values changed. Review affected suggestions before applying.');
        return;
      }
      const accepted = valid.keys
        .map(key => latestReviews[key])
        .map(review => ({
          entryId: fresh.entryId,
          fieldId: review.task.fieldId,
          kind: review.task.kind,
          sourceLocale: review.task.sourceLocale,
          targetLocale: review.task.targetLocale,
          sourceSnapshot: review.task.sourceSnapshot,
          targetSnapshot: review.task.targetSnapshot,
          dependencies: review.dependencies ?? [],
          suggestion: review.suggestion,
          warningApproved: warningApproved(review),
        }));
      const acceptedKeys = new Set(valid.keys);
      const outcomes = runTasksRef.current
        .filter(task => !acceptedKeys.has(task.key))
        .map(task => ({ key: task.key, ...unappliedOutcome(latestReviews[task.key], fresh) }));
      sdk.close({ choice: 'suggestion', accepted, outcomes } satisfies DialogResult);
    } catch {
      setStatus('Could not confirm current editor values. Try Apply again.');
    } finally {
      setApplying(false);
    }
  }
  const expandedTask = expandedKey ? runTasks.find(task => task.key === expandedKey) : undefined;
  const expandedReview = expandedKey ? reviews[expandedKey] : undefined;
  const tabTasks = runTasks.filter(task => task.targetLocale === activeTab);
  const expandables = tabTasks.filter(
    task =>
      task.kind === 'richText' ||
      expandableType(task, snapshot?.controls?.find(item => item.fieldId === task.fieldId)?.widgetId),
  );
  const expandedIndex = expandedTask ? expandables.findIndex(task => task.key === expandedTask.key) : -1;

  function blocked(title: string, description: string, action?: React.ReactNode, waiting = false) {
    return (
      <div className="dialog-frame">
        <div className="dialog-blocked" role="status">
          {waiting && <Spinner size="medium" />}
          <Heading as="h2">{title}</Heading>
          <Paragraph>{description}</Paragraph>
          {action}
        </div>
      </div>
    );
  }
  if (!snapshot)
    return syncing
      ? blocked('Reading the entry…', 'Includes changes you haven’t saved yet.', undefined, true)
      : blocked(
          'Can’t read the entry',
          'Close this window and open AI Translator again.',
          <Button onClick={() => sdk.close()}>Close</Button>,
        );
  if (!liveUpdatesAvailable)
    return blocked(
      'Can’t read the entry',
      'Close this window and open AI Translator again.',
      <Button onClick={() => sdk.close()}>Close</Button>,
    );
  if (config.transport === 'function' && !functionConfigError && functionStatus === 'checking')
    return blocked('Checking translation service…', 'Confirming the saved Function connection.', undefined, true);
  if (config.transport === 'function' && !functionConfigError && functionStatus === 'failed')
    return blocked(
      'Can’t connect to translation service',
      functionProblem,
      <div className="dialog-blocked-actions">
        <Button onClick={() => sdk.close()}>Close</Button>
        <Button variant="primary" onClick={() => void sdk.navigator.openAppConfig()}>
          Open app configuration
        </Button>
      </div>,
    );
  const relayChecked = config.transport !== 'function' && Boolean(config.backendUrl) && isConfigured(config);
  if (relayChecked && relayStatus === 'checking')
    return blocked('Checking translation service…', 'Confirming the backend and its providers.', undefined, true);
  if (relayChecked && relayStatus === 'failed')
    return blocked(
      'Can’t connect to translation service',
      relayProblem,
      <div className="dialog-blocked-actions">
        <Button onClick={() => sdk.close()}>Close</Button>
        <Button variant="primary" onClick={() => void sdk.navigator.openAppConfig()}>
          Open app configuration
        </Button>
      </div>,
    );
  if (!configured)
    return blocked(
      'AI Translator isn’t set up yet',
      'A space admin needs to connect a translation service in the app configuration.',
      <div className="dialog-blocked-actions">
        <Button onClick={() => sdk.close()}>Close</Button>
        <Button variant="primary" onClick={() => void sdk.navigator.openAppConfig()}>
          Open app configuration
        </Button>
      </div>,
    );
  if (profileState.error)
    return blocked(
      'Instruction profile is invalid',
      profileState.error,
      <Button onClick={() => sdk.close()}>Close</Button>,
    );
  if (profile && instructionStatus === 'mismatch')
    return blocked(
      'Instruction profile changed',
      'The Function has a different saved instruction revision. Close and reopen the translator to load the latest settings.',
      <Button onClick={() => sdk.close()}>Close</Button>,
    );
  const launchProblem = launch && fieldSourceProblem(snapshot, launch.field, source);
  if (screen === 'choose' && launch && launchProblem)
    return blocked(
      launchProblem === 'empty' || launchProblem === 'ineligible'
        ? `${launch.field.name} is empty in ${localeName(source, localeNames)}`
        : `${launch.field.name} can’t be translated from ${localeName(source, localeNames)}`,
      launchProblem === 'empty' || launchProblem === 'ineligible'
        ? `Add text to ${launch.field.name} in ${localeName(source, localeNames)}, then translate again.`
        : launchProblem,
      <Button onClick={() => sdk.close()}>Close</Button>,
    );
  if (screen === 'choose' && eligibleFields.length === 0)
    return blocked(
      `Nothing to translate from ${localeName(source, localeNames)}`,
      `No translatable field has text to translate in ${localeName(source, localeNames)}. Pick another language to translate from.`,
      <div className="dialog-blocked-picker">
        <label htmlFor="blocked-source">Translate from</label>
        <Select id="blocked-source" value={source} onChange={event => setSource(event.target.value)}>
          {snapshot.locales.map(locale => (
            <Select.Option key={locale} value={locale}>
              {localeName(locale, localeNames)}
            </Select.Option>
          ))}
        </Select>
      </div>,
    );
  const destination =
    config.transport === 'function'
      ? `Contentful App Action translateProvider in ${sdk.ids.space}/${sdk.ids.environment}; provider ${config.functionProviderUrl ?? 'not configured'}`
      : config.backendUrl
        ? `${config.backendUrl.replace(/\/$/, '')}/v1/translate; provider ${relayAlias ?? 'not chosen'}`
        : 'Translation service not configured';
  const choiceCount = summary.count;
  const expandedProps =
    expandedTask && expandedReview
      ? {
          task: expandedTask,
          sdk,
          entryId: snapshot.entryId,
          contentTypeId: snapshot.contentTypeId,
          definition: taskDefinition(expandedTask, snapshot),
          instanceParameters: (snapshot.controls?.find(item => item.fieldId === expandedTask.fieldId)?.settings ??
            {}) as Record<string, unknown>,
          review: expandedReview,
          index: tabTasks.findIndex(task => task.key === expandedTask.key) + 1,
          total: tabTasks.length,
          canPrevious: expandedIndex > 0,
          canNext: expandedIndex < expandables.length - 1,
          localeNames,
          onBack: () => setExpandedKey(undefined),
          onPrevious: () => setExpandedKey(expandables[expandedIndex - 1]?.key),
          onNext: () => setExpandedKey(expandables[expandedIndex + 1]?.key),
          onChoice: (choice: Review['choice']) => updateReview(expandedTask.key, { choice }),
          onApproveWarning: () => approveWarning(expandedReview),
          onRestore: () => restoreSuggestion(expandedReview),
          canUse: usableReview(expandedReview, snapshot, usableProvider, profile?.revision),
        }
      : undefined;
  const expandType =
    expandedTask &&
    expandableType(expandedTask, snapshot.controls?.find(item => item.fieldId === expandedTask.fieldId)?.widgetId);
  const expandedView =
    expandedProps &&
    expandedTask &&
    expandedReview &&
    (expandedTask.kind === 'richText' ? (
      <RichTextExpand
        key={expandedTask.key}
        {...expandedProps}
        onSuggestion={value => {
          const current = reviewsRef.current[expandedTask.key];
          if (current && current.editorRevision === expandedReview.editorRevision) updateRichSuggestion(current, value);
        }}
      />
    ) : expandType ? (
      <ExpandView
        key={expandedTask.key}
        {...expandedProps}
        type={expandType}
        onSuggestion={value => {
          const current = reviewsRef.current[expandedTask.key];
          if (current && current.editorRevision === expandedReview.editorRevision)
            updateReview(expandedTask.key, { suggestion: value });
        }}
      />
    ) : undefined);
  return (
    <div className={`dialog-frame${expandedView ? ' dialog-frame-expanded' : ''}`}>
      <div className="dialog-body" key={screen}>
        {screen === 'choose' ? (
          <ChooseScreen
            snapshot={snapshot}
            localeNames={localeNames}
            source={source}
            launchField={launch?.field}
            onSource={value => {
              resetReview();
              setSource(value);
              setFields([]);
            }}
            saveDefault={saveDefault}
            onSaveDefault={setSaveDefault}
            canSaveDefault={sourcePreference.available}
            targets={targets}
            onTarget={value => toggle(targets, setTargets, value)}
            saveTargetDefault={saveTargetDefault}
            onSaveTargetDefault={setSaveTargetDefault}
            canSaveTargetDefault={targetPreference.available}
            fields={fields}
            eligibleFields={eligibleFields}
            onField={value => toggle(fields, setFields, value)}
            onSelectAll={() => {
              resetReview();
              setFields(eligibleFields.map(field => field.id));
            }}
            guidance={runGuidance}
            onGuidance={value => {
              resetReview();
              setRunGuidance(value);
            }}
            profile={profile}
            variableValues={variableValues}
            onVariableValue={(key, value) => {
              resetReview();
              setVariableValues(current => ({ ...current, [key]: value }));
            }}
            selectedContext={selectedContext}
            contextCandidates={contextCandidates}
            onContext={toggleContext}
            contextKey={contextKey}
            sentContext={contextResult.items}
            contextError={contextResult.error}
            search={entrySearch}
            onSearch={setEntrySearch}
            hits={entryHits}
            onLoadEntry={entryId => void addSavedEntry(entryId)}
            contextStatus={contextStatus}
            planned={planResult.plan?.requests ?? []}
            planWarnings={planResult.plan?.warnings ?? []}
            planError={
              config.transport === 'function'
                ? (functionConfigError ?? (functionStatus !== 'ready' ? functionProblem : planResult.error))
                : planResult.error
            }
            settings={settings}
            debugMode={config.debugMode}
            destination={destination}
            model={model}
            transport={config.transport === 'function' ? 'function' : 'custom'}
            choice={choice}
            choices={choices}
            onChoice={key => {
              resetReview();
              setChoiceKey(key);
            }}
            saveChoiceDefault={saveChoiceDefault}
            onSaveChoiceDefault={setSaveChoiceDefault}
            canSaveChoiceDefault={choicePreference.available}
          />
        ) : (
          (expandedView ?? (
            <ReviewScreen
              sdk={sdk}
              tasks={runTasks}
              reviews={reviews}
              snapshot={snapshot}
              localeNames={localeNames}
              targets={targets}
              activeTab={activeTab}
              onTab={setActiveTab}
              sourceOpen={sourceOpen}
              onSourceOpen={setSourceOpen}
              nowOpen={nowOpen}
              onNowOpen={(locale, open) => setNowOpen(value => ({ ...value, [locale]: open }))}
              generating={generating}
              progress={progress}
              run={run}
              onStop={() => {
                controllerRef.current?.abort();
                setStatus('Stopping…');
              }}
              onUseAll={locale =>
                setReviews(value =>
                  chooseSuggestionsInTab(runTasks, value, locale, snapshot, usableProvider, profile?.revision),
                )
              }
              onChoice={(key, choice) => updateReview(key, { choice })}
              onSuggestion={(key, suggestion) => updateReview(key, { suggestion })}
              onRetry={(keys, smaller) => prepareRetry(keys, smaller)}
              canRetrySmaller={code => smallerRetryApplies(code)}
              pendingRetry={pendingRetry}
              onStartRetry={() => void startRetry()}
              onCancelRetry={() => setPendingRetry(undefined)}
              debugMode={config.debugMode}
              onExpand={setExpandedKey}
              onRestore={restoreSuggestion}
              onApproveWarning={approveWarning}
              usableProvider={usableProvider}
              profileRevision={profile?.revision}
            />
          ))
        )}
      </div>
      {status && (
        <div className="dialog-live-status" role="status">
          {status}
        </div>
      )}
      <footer className="dialog-footer">
        {screen === 'choose' ? (
          <>
            <p>
              <strong>
                {tasks.length} suggestion{tasks.length === 1 ? '' : 's'}
              </strong>{' '}
              · {fields.length} field{fields.length === 1 ? '' : 's'} into {targets.length} language
              {targets.length === 1 ? '' : 's'}
              {planResult.plan
                ? ` · ${planResult.plan.requests.length} request${planResult.plan.requests.length === 1 ? '' : 's'}`
                : ''}
            </p>
            <div className="dialog-footer-actions">
              <Button onClick={() => sdk.close()}>Cancel</Button>
              <Button
                variant="primary"
                isDisabled={!canTranslate}
                onClick={() => {
                  if (saveDefault) savePreference(sourcePreferenceKey, source);
                  if (saveChoiceDefault && choice) savePreference(choicePreferenceKey, choice.key);
                  if (saveTargetDefault) saveTargetPreference(targetPreferenceKey, targets);
                  void generate();
                }}
              >
                Translate
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>
              <strong>
                {generating
                  ? 'Nothing will be written yet'
                  : `Writes ${choiceCount} value${choiceCount === 1 ? '' : 's'} to the draft`}
              </strong>
              {!generating && ' · Nothing is published'}
            </p>
            <div className="dialog-footer-actions">
              <Button
                onClick={() => {
                  if (generating) controllerRef.current?.abort();
                  resetReview();
                }}
              >
                Back
              </Button>
              <Button className="dialog-cancel" onClick={() => sdk.close()}>
                Cancel
              </Button>
              <Button
                variant="primary"
                isDisabled={generating || applying || choiceCount === 0}
                onClick={() => void closeWithChoices()}
              >
                {applying
                  ? 'Checking…'
                  : generating
                    ? 'Apply'
                    : `Apply ${choiceCount} value${choiceCount === 1 ? '' : 's'}`}
              </Button>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}
