import type { ContentTypeField, DialogAppSDK } from '@contentful/app-sdk';
import {
  Accordion,
  Badge,
  Button,
  ButtonGroup,
  IconButton,
  Note,
  SkeletonBodyText,
  SkeletonContainer,
  Spinner,
  Tabs,
  Textarea,
  TextInput,
} from '@contentful/f36-components';
import { ArrowsOutIcon, CaretLeftIcon, CaretRightIcon, CheckIcon } from '@contentful/f36-icons';
import { lazy, Suspense } from 'react';
import type { Task, TaskResult } from '../batch';
import type { PendingRetry, RunProgress } from '../dialog';
import type { EditorSnapshot } from '../editor-snapshot';
import { type RunState, taskParts } from '../run';
import { expandableType } from './ExpandView';
import {
  failureCopy,
  fieldTypeLabel,
  hasContent,
  isCurrent,
  localeName,
  type Review,
  suggestionError,
  taskDefinition,
  usableReview,
} from './model';
import { DialogRichTextPreview } from './RichTextView';
import { ValidationNote } from './ValidationNote';

type Props = {
  sdk: DialogAppSDK;
  tasks: Task[];
  reviews: Record<string, Review>;
  snapshot: EditorSnapshot;
  localeNames: Record<string, string>;
  targets: string[];
  activeTab: string;
  onTab: (locale: string) => void;
  sourceOpen: boolean;
  onSourceOpen: (open: boolean) => void;
  nowOpen: Record<string, boolean>;
  onNowOpen: (locale: string, open: boolean) => void;
  generating: boolean;
  progress?: RunProgress;
  run: RunState;
  onStop: () => void;
  onUseAll: (locale: string) => void;
  onChoice: (key: string, choice: Review['choice']) => void;
  onSuggestion: (key: string, suggestion: string | string[]) => void;
  onRetry: (keys: string[], smaller: boolean) => void;
  canRetrySmaller: (code: string | undefined) => boolean;
  pendingRetry?: PendingRetry;
  onStartRetry: () => void;
  onCancelRetry: () => void;
  debugMode?: unknown;
  onExpand: (key: string) => void;
  onRestore: (review: Review) => void;
  onApproveWarning: (review: Review) => void;
  usableProvider: (provider: TaskResult['provider']) => boolean;
  profileRevision?: string;
};

const NativeFieldEditor = lazy(() => import('./NativeFieldEditor'));

function MarkdownValue({
  sdk,
  snapshot,
  definition,
  locale,
  value,
  label,
  onChange,
}: {
  sdk: DialogAppSDK;
  snapshot: EditorSnapshot;
  definition: ContentTypeField;
  locale: string;
  value: string;
  label: string;
  onChange?: (value: string) => void;
}) {
  return (
    <section aria-label={label}>
      <Suspense fallback={<p className="dialog-muted">Loading Markdown editor…</p>}>
        <NativeFieldEditor
          sdk={sdk}
          entryId={snapshot.entryId}
          contentTypeId={snapshot.contentTypeId}
          definition={definition}
          instanceParameters={snapshot.controls?.find(item => item.fieldId === definition.id)?.settings}
          locale={locale}
          value={value}
          kind="markdown"
          readOnly={!onChange}
          minHeight={120}
          onChange={onChange ? next => onChange(next as string) : undefined}
        />
      </Suspense>
    </section>
  );
}

function Value({ value, rich }: { value: unknown; rich?: boolean }) {
  if (value === null || value === undefined || value === '')
    return <div className="dialog-value dialog-empty">Empty</div>;
  if (rich)
    return (
      <div className="dialog-value">
        <DialogRichTextPreview value={value} />
      </div>
    );
  if (Array.isArray(value))
    return value.length ? (
      <div className="dialog-array-values">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: read-only values can repeat and never reorder.
          <div className="dialog-value" key={index}>
            {String(item)}
          </div>
        ))}
      </div>
    ) : (
      <div className="dialog-value dialog-empty">Empty</div>
    );
  return <div className="dialog-value">{String(value)}</div>;
}

// A review column heading whose button hides the column to give the others its width.
function ColumnHead({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  const action = `${open ? 'Hide' : 'Show'} ${label}`;
  return (
    <span className="dialog-column-head">
      {open && <span aria-hidden="true">{label}</span>}
      <IconButton
        variant="transparent"
        size="small"
        icon={open ? <CaretLeftIcon /> : <CaretRightIcon />}
        aria-label={action}
        aria-expanded={open}
        withTooltip
        tooltipProps={{ content: action, placement: 'top' }}
        onClick={onToggle}
      />
    </span>
  );
}

function Decision({
  review,
  canUse,
  onChoice,
  label,
}: {
  review?: Review;
  canUse: boolean;
  onChoice: (choice: Review['choice']) => void;
  label: string;
}) {
  return (
    <ButtonGroup variant="merged" className="dialog-decision" aria-label={label}>
      <Button
        startIcon={review?.choice === 'keep' ? <CheckIcon size="tiny" /> : undefined}
        isActive={review?.choice === 'keep'}
        aria-pressed={review?.choice === 'keep'}
        isDisabled={review?.status !== 'ready'}
        onClick={() => onChoice('keep')}
      >
        Keep current
      </Button>
      <Button
        startIcon={review?.choice === 'suggestion' ? <CheckIcon size="tiny" /> : undefined}
        isActive={review?.choice === 'suggestion'}
        aria-pressed={review?.choice === 'suggestion'}
        isDisabled={!canUse}
        onClick={() => onChoice('suggestion')}
      >
        Use new
      </Button>
    </ButtonGroup>
  );
}

function RetryPanel(props: Props) {
  const retry = props.pendingRetry;
  if (!retry) return null;
  if ('message' in retry)
    return (
      <Note variant="warning" role="alert">
        <div className="dialog-review-note">
          <div>{retry.message}</div>
          <div className="dialog-review-note-actions">
            <Button size="small" onClick={props.onCancelRetry}>
              Close
            </Button>
          </div>
        </div>
      </Note>
    );
  const requests = retry.plan.requests;
  const names = [...new Set(requests.flatMap(request => request.parts.map(part => part.task.fieldName)))];
  return (
    <Note variant="primary" role="status">
      <div className="dialog-review-note">
        <div>
          {retry.smaller ? 'Retry in smaller batches' : 'Retry'} sends {requests.length} request
          {requests.length === 1 ? '' : 's'} for {names.join(', ')}.{' '}
          {retry.smaller &&
            'Each request is a separate model call, and parts translated separately can differ slightly in wording. '}
          Completed suggestions are kept.
          {requests.some(request =>
            request.context.some(item => item.role === 'outline' || item.role === 'neighbor'),
          ) && ' Split parts include the surrounding source and headings as context.'}
          {requests.some(request => request.context.some(item => item.role === 'sibling')) &&
            ' Fields sent in other requests are included as context.'}
          {retry.plan.warnings.map(warning => (
            <p className="dialog-muted" key={warning}>
              {warning}
            </p>
          ))}
          {props.debugMode === true && (
            <Accordion className="dialog-request-list">
              {requests.map((request, index) => (
                <Accordion.Item key={request.request.requestId} titleElement="h4" title={`Request ${index + 1}`}>
                  {request.messages.map((message, position) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed preview whose messages can repeat.
                    <div key={position}>
                      <strong>{message.role}</strong>
                      <pre>{message.content}</pre>
                    </div>
                  ))}
                </Accordion.Item>
              ))}
            </Accordion>
          )}
        </div>
        <div className="dialog-review-note-actions">
          <Button size="small" variant="primary" onClick={props.onStartRetry}>
            Start
          </Button>
          <Button size="small" onClick={props.onCancelRetry}>
            Cancel
          </Button>
        </div>
      </div>
    </Note>
  );
}

export function ReviewScreen(props: Props) {
  const selected = props.activeTab || props.targets[0];
  const tabTasks = props.tasks.filter(task => task.targetLocale === selected);
  const ready = props.tasks.filter(task => props.reviews[task.key]?.status === 'ready').length;
  // A stale failure needs a new run from the start, as its row says, so a
  // retry would only fail again.
  const failedKeys = props.tasks
    .filter(task => {
      const review = props.reviews[task.key];
      return (review?.status === 'error' && review.code !== 'stale') || review?.status === 'cancelled';
    })
    .map(task => task.key);
  const failed = props.tasks.filter(task => props.reviews[task.key]?.status === 'error').length;
  const attention = props.tasks.filter(task => {
    const review = props.reviews[task.key];
    return review?.status === 'ready' && (Boolean(suggestionError(review)) || !isCurrent(review, props.snapshot));
  }).length;
  const currentName = localeName(selected, props.localeNames);
  // The "now" column starts hidden when no field in the tab has a value yet.
  const nowOpen =
    props.nowOpen[selected] ??
    tabTasks.some(task => hasContent(props.snapshot.fields[task.fieldId]?.[task.targetLocale]));
  const sourceName = localeName(props.tasks[0]?.sourceLocale ?? '', props.localeNames);
  return (
    <div
      className={`dialog-review${props.sourceOpen ? '' : ' dialog-review-source-closed'}${nowOpen ? '' : ' dialog-review-now-closed'}`}
    >
      <div className="dialog-review-bar">
        <Tabs currentTab={selected} onTabChange={props.onTab}>
          <Tabs.List>
            {props.targets.map(locale => {
              const tasks = props.tasks.filter(task => task.targetLocale === locale);
              const failures = tasks.filter(task => props.reviews[task.key]?.status === 'error').length;
              const problems = tasks.filter(task => {
                const review = props.reviews[task.key];
                return (
                  review?.status === 'ready' && (Boolean(suggestionError(review)) || !isCurrent(review, props.snapshot))
                );
              }).length;
              const done = tasks.filter(task => props.reviews[task.key]?.status === 'ready').length;
              return (
                <Tabs.Tab key={locale} panelId={locale}>
                  {localeName(locale, props.localeNames)}{' '}
                  <Badge variant={failures ? 'negative' : problems ? 'warning' : 'secondary'}>
                    {failures
                      ? `${failures} failed`
                      : problems
                        ? `${problems} need attention`
                        : props.generating
                          ? `${done} of ${tasks.length}`
                          : tasks.length}
                  </Badge>
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </Tabs>
        <div className="dialog-review-status" role="status">
          {props.generating ? (
            <>
              <Spinner size="small" /> Request {props.progress?.request ?? 1} of {props.progress?.requests ?? 1} ·{' '}
              {props.progress?.ready ?? 0} of {props.progress?.total ?? props.tasks.length} suggestions ready
              <Button size="small" onClick={props.onStop}>
                Stop
              </Button>
            </>
          ) : (
            <>
              {ready - attention} ready{failed ? ` · ${failed} failed` : ''}
              {attention ? ` · ${attention} need attention` : ''}
              {failedKeys.length > 0 && (
                <Button size="small" onClick={() => props.onRetry(failedKeys, false)}>
                  Retry failed
                </Button>
              )}
              <Button variant="transparent" size="small" onClick={() => props.onUseAll(selected)}>
                Use all new {currentName}
              </Button>
            </>
          )}
        </div>
      </div>
      <RetryPanel {...props} />
      <div className="dialog-review-head">
        <span aria-hidden="true">Field</span>
        <ColumnHead label={sourceName} open={props.sourceOpen} onToggle={() => props.onSourceOpen(!props.sourceOpen)} />
        <ColumnHead label={`${currentName} now`} open={nowOpen} onToggle={() => props.onNowOpen(selected, !nowOpen)} />
        <span aria-hidden="true">{currentName} suggestion</span>
        <span aria-hidden="true">Decision</span>
      </div>
      <div className="dialog-review-rows">
        {tabTasks.map(task => {
          const review = props.reviews[task.key];
          const stale = Boolean(review && !isCurrent(review, props.snapshot));
          const usable = usableReview(review, props.snapshot, props.usableProvider, props.profileRevision);
          const running = props.generating && Boolean(props.progress?.running.includes(task.key));
          const parts = taskParts(props.run, task.key);
          const done = parts.filter(part => part.outcome.status === 'ok').length;
          const source = props.snapshot.fields[task.fieldId]?.[task.sourceLocale];
          const now = props.snapshot.fields[task.fieldId]?.[task.targetLocale];
          const widgetId = props.snapshot.controls?.find(item => item.fieldId === task.fieldId)?.widgetId;
          const type = fieldTypeLabel(taskDefinition(task, props.snapshot), source, widgetId);
          const markdown = type === 'Markdown';
          const markdownProps = {
            sdk: props.sdk,
            snapshot: props.snapshot,
            definition: taskDefinition(task, props.snapshot),
          };
          return (
            <article className="dialog-review-row" key={task.key} aria-label={`${task.fieldName}, ${currentName}`}>
              <div className="dialog-row-field">
                <strong>{task.fieldName}</strong>
                <span>{type}</span>
                {review?.status === 'ready' && (task.kind === 'richText' || expandableType(task, widgetId)) && (
                  <Button variant="transparent" size="small" onClick={() => props.onExpand(task.key)}>
                    <ArrowsOutIcon size="tiny" /> Expand
                  </Button>
                )}
              </div>
              <div className="dialog-row-cell dialog-source-value">
                <span className="dialog-cell-label">{localeName(task.sourceLocale, props.localeNames)}</span>
                {markdown && typeof source === 'string' && source !== '' ? (
                  <MarkdownValue
                    {...markdownProps}
                    locale={task.sourceLocale}
                    value={source}
                    label={`${sourceName} source for ${task.fieldName}`}
                  />
                ) : (
                  <Value value={source} rich={task.kind === 'richText'} />
                )}
              </div>
              <div className="dialog-row-cell dialog-now-value">
                <span className="dialog-cell-label">{currentName} now</span>
                {markdown && typeof now === 'string' && now !== '' ? (
                  <MarkdownValue
                    {...markdownProps}
                    locale={task.targetLocale}
                    value={now}
                    label={`${currentName} current value for ${task.fieldName}`}
                  />
                ) : (
                  <Value value={now} rich={task.kind === 'richText'} />
                )}
              </div>
              <div className="dialog-row-cell dialog-suggestion">
                <span className="dialog-cell-label">{currentName} suggestion</span>
                {review?.status === 'ready' && markdown ? (
                  <MarkdownValue
                    key={review.editorRevision ?? 0}
                    {...markdownProps}
                    locale={task.targetLocale}
                    value={review.suggestion as string}
                    label={`${currentName} suggestion for ${task.fieldName}`}
                    onChange={next => props.onSuggestion(task.key, next)}
                  />
                ) : review?.status === 'ready' && task.kind === 'text' ? (
                  <Textarea
                    aria-label={`${currentName} suggestion for ${task.fieldName}`}
                    value={review.suggestion as string}
                    rows={2}
                    isInvalid={Boolean(suggestionError(review))}
                    onChange={event => props.onSuggestion(task.key, event.target.value)}
                  />
                ) : review?.status === 'ready' && task.kind === 'array' ? (
                  <div className="dialog-array-values">
                    {(review.suggestion as string[]).map((item, index) => (
                      <TextInput
                        // biome-ignore lint/suspicious/noArrayIndexKey: items keep their positions and can repeat.
                        key={index}
                        aria-label={`${currentName} suggestion for ${task.fieldName}, item ${index + 1}`}
                        value={item}
                        onChange={event =>
                          props.onSuggestion(
                            task.key,
                            (review.suggestion as string[]).map((value, i) =>
                              i === index ? event.target.value : value,
                            ),
                          )
                        }
                      />
                    ))}
                  </div>
                ) : review?.status === 'ready' && task.kind === 'richText' ? (
                  <>
                    <div className="dialog-rich-suggestion">
                      <DialogRichTextPreview value={review.suggestion} />
                    </div>
                    <Button variant="transparent" size="small" onClick={() => props.onExpand(task.key)}>
                      Edit text
                    </Button>
                  </>
                ) : review?.status === 'error' ? (
                  <Note variant={review.rawSuggestion !== undefined ? 'warning' : 'negative'}>
                    <div className="dialog-review-note">
                      <div>
                        {failureCopy(review)}
                        {parts.length > 1 && done ? ` ${done} of ${parts.length} parts finished and are kept.` : ''}
                      </div>
                      {review.rawSuggestion !== undefined && (
                        <div className="dialog-debug">
                          <p>
                            The model's suggestion could not be converted to an editable value. Review it below or
                            retry.
                          </p>
                          <pre>{review.rawSuggestion}</pre>
                        </div>
                      )}
                      {review.debug && (
                        <details className="dialog-debug">
                          <summary>Debug details from the translation service</summary>
                          <pre>{review.debug}</pre>
                        </details>
                      )}
                      {!props.generating && review.code !== 'stale' && (
                        <div className="dialog-review-note-actions">
                          <Button size="small" onClick={() => props.onRetry([task.key], false)}>
                            Retry
                          </Button>
                          {props.canRetrySmaller(review.code) && (
                            <Button size="small" onClick={() => props.onRetry([task.key], true)}>
                              Retry in smaller batches
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </Note>
                ) : review?.status === 'cancelled' ? (
                  <div className="dialog-waiting">
                    Stopped{' '}
                    {!props.generating && (
                      <Button size="small" onClick={() => props.onRetry([task.key], false)}>
                        Retry
                      </Button>
                    )}
                  </div>
                ) : running ? (
                  <>
                    <div className="dialog-skeleton">
                      <SkeletonContainer width="100%" height={56}>
                        <SkeletonBodyText numberOfLines={3} />
                      </SkeletonContainer>
                    </div>
                    <p className="dialog-muted">
                      Translating{parts.length > 1 ? ` · ${done} of ${parts.length} parts done` : ''}
                    </p>
                  </>
                ) : (
                  <div className="dialog-waiting">Waiting</div>
                )}
                {review?.status === 'ready' && (
                  <ValidationNote
                    review={review}
                    onApproveWarning={() => props.onApproveWarning(review)}
                    onRestore={() => props.onRestore(review)}
                  />
                )}
                {review?.status === 'ready' && review.warning && <Note variant="warning">{review.warning}</Note>}
                {stale && (
                  <Note variant="warning">
                    A value sent with this translation changed in the editor after it was translated. Go Back and
                    translate again to use the latest values.
                  </Note>
                )}
                {review?.status === 'ready' &&
                  props.profileRevision &&
                  review.profileRevision !== props.profileRevision && (
                    <Note variant="warning">
                      The instruction profile changed. Translate this field again before applying it.
                    </Note>
                  )}
                {review?.status === 'ready' && !props.usableProvider(review.provider) && (
                  <Note variant="warning">This test result cannot be applied to a draft.</Note>
                )}
              </div>
              <div className="dialog-row-decision">
                <Decision
                  review={review}
                  canUse={usable}
                  onChoice={choice => props.onChoice(task.key, choice)}
                  label={`Decision for ${task.fieldName} in ${currentName}`}
                />
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
