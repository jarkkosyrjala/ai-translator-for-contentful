import type { ContentTypeField, DialogAppSDK } from '@contentful/app-sdk';
import { Button, ButtonGroup } from '@contentful/f36-components';
import { CaretLeftIcon, CaretRightIcon, CheckIcon } from '@contentful/f36-icons';
import type { Document } from '@contentful/rich-text-types';
import React, { Suspense } from 'react';
import type { Task } from '../batch';
import { localeName, type Review } from './model';
import { richTextWordCount } from './RichTextView';
import { ValidationNote } from './ValidationNote';

const NativeFieldEditor = React.lazy(() => import('./NativeFieldEditor'));

type Props = {
  task: Task;
  sdk: DialogAppSDK;
  entryId: string;
  contentTypeId: string;
  definition: ContentTypeField;
  instanceParameters?: Record<string, unknown>;
  review: Review;
  index: number;
  total: number;
  canPrevious: boolean;
  canNext: boolean;
  localeNames: Record<string, string>;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onChoice: (choice: Review['choice']) => void;
  onSuggestion: (value: Document) => void;
  onRestore: () => void;
  onApproveWarning: () => void;
  canUse: boolean;
};

export function RichTextExpand(props: Props) {
  const name = localeName(props.task.targetLocale, props.localeNames);
  const decision = (
    <ButtonGroup variant="merged">
      <Button
        isActive={props.review.choice === 'keep'}
        aria-pressed={props.review.choice === 'keep'}
        onClick={() => props.onChoice('keep')}
      >
        {props.review.choice === 'keep' && <CheckIcon size="tiny" />}Keep current
      </Button>
      <Button
        isActive={props.review.choice === 'suggestion'}
        aria-pressed={props.review.choice === 'suggestion'}
        isDisabled={!props.canUse}
        onClick={() => props.onChoice('suggestion')}
      >
        {props.review.choice === 'suggestion' && <CheckIcon size="tiny" />}Use new
      </Button>
    </ButtonGroup>
  );
  return (
    <div className="dialog-expand dialog-rich-expand">
      <div className="dialog-expand-bar">
        <Button variant="transparent" onClick={props.onBack}>
          ← <span className="dialog-expand-all">All fields</span>
          <span className="dialog-expand-mobile-name">
            {props.task.fieldName} · {name}
          </span>
        </Button>
        <strong>
          {props.task.fieldName} <span>· {name} suggestion</span>
        </strong>
        <div className="dialog-expand-nav">
          <span className="dialog-nav-desktop">
            Field {props.index} of {props.total}
          </span>
          <span className="dialog-nav-mobile">
            {props.index} of {props.total}
          </span>
          <Button size="small" aria-label="Previous field" isDisabled={!props.canPrevious} onClick={props.onPrevious}>
            <CaretLeftIcon />
          </Button>
          <Button size="small" aria-label="Next field" isDisabled={!props.canNext} onClick={props.onNext}>
            <CaretRightIcon />
          </Button>
        </div>
        <div className="dialog-expand-choice">{decision}</div>
      </div>
      <main className="dialog-expand-body">
        <div className="dialog-expand-editor">
          <div className="dialog-rich-review-actions">
            <Button
              variant="transparent"
              size="small"
              onClick={props.onRestore}
              isDisabled={!props.review.originalSuggestion}
            >
              Restore generated text
            </Button>
            <span>{richTextWordCount(props.review.suggestion)} words</span>
          </div>
          <section className="dialog-native-rich-editor" aria-label={`${name} suggestion for ${props.task.fieldName}`}>
            <Suspense fallback={<p className="dialog-muted">Loading Rich Text editor…</p>}>
              <NativeFieldEditor
                key={props.review.editorRevision ?? 0}
                sdk={props.sdk}
                entryId={props.entryId}
                contentTypeId={props.contentTypeId}
                definition={props.definition}
                instanceParameters={props.instanceParameters}
                locale={props.task.targetLocale}
                value={props.review.suggestion as Document}
                kind="richText"
                onChange={value => props.onSuggestion(value as Document)}
              />
            </Suspense>
          </section>
          <ValidationNote review={props.review} onApproveWarning={props.onApproveWarning} onRestore={props.onRestore} />
        </div>
      </main>
      <div className="dialog-expand-mobile-actions">
        {decision}
        <Button onClick={props.onBack}>Back to all fields</Button>
      </div>
    </div>
  );
}
