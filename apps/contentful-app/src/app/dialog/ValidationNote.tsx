import { Button, Note } from '@contentful/f36-components';
import { type Review, suggestionEdited, suggestionWarning, validationCopy, warningApproved } from './model';

// A suggestion's validation result. A warning about changed protected text
// can be approved for the exact suggestion; an edited suggestion can return
// to the generated one.
export function ValidationNote(props: { review: Review; onApproveWarning: () => void; onRestore: () => void }) {
  const validation = validationCopy(props.review);
  if (!validation) return null;
  const warning = suggestionWarning(props.review);
  const approved = Boolean(warning) && warningApproved(props.review);
  const canApprove = Boolean(warning) && !approved;
  const canRestore = suggestionEdited(props.review);
  return (
    <Note variant={warning ? 'warning' : 'negative'}>
      <div className="dialog-review-note">
        <div>
          {validation}
          {approved && ' Approved for this suggestion.'}
        </div>
        {(canApprove || canRestore) && (
          <div className="dialog-review-note-actions">
            {canApprove && (
              <Button size="small" onClick={props.onApproveWarning}>
                Approve this change
              </Button>
            )}
            {canRestore && (
              <Button size="small" onClick={props.onRestore}>
                Restore generated text
              </Button>
            )}
          </div>
        )}
      </div>
    </Note>
  );
}
