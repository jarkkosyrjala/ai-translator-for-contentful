import type { SidebarAppSDK } from '@contentful/app-sdk';
import { Button, Note } from '@contentful/f36-components';
import { CheckCircleIcon, MinusIcon, TranslateIcon, WarningIcon } from '@contentful/f36-icons';
import { useEffect, useRef, useState } from 'react';
import { capture, type EditorSnapshot, subscribeToEditorValues } from './editor-snapshot';
import { functionHealthMatches, functionReadinessError } from './function-config';
import { functionHealth } from './function-transport';
import { openTranslator } from './launch';
import { type ApplyLine, isConfigured, outcomeLine, readinessLine, readyFieldCount } from './sidebar-model';
import type { Params } from './transport-config';

export function Sidebar({ sdk }: { sdk: SidebarAppSDK<Params> }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [applyLines, setApplyLines] = useState<ApplyLine[]>([]);
  const [hasOutcome, setHasOutcome] = useState(false);
  const [snapshot, setSnapshot] = useState<EditorSnapshot>(() => capture(sdk));
  const [functionStatus, setFunctionStatus] = useState<'checking' | 'ready' | 'failed'>('checking');
  const [functionProblem, setFunctionProblem] = useState('');
  const runInProgress = useRef(false);
  useEffect(() => subscribeToEditorValues(sdk, setSnapshot), [sdk]);
  // The editor's focused locale decides which values the button counts.
  useEffect(() => sdk.editor.onLocaleSettingsChanged(() => setSnapshot(capture(sdk))), [sdk]);
  useEffect(() => {
    if (sdk.parameters.installation.transport !== 'function' || functionReadinessError(sdk.parameters.installation))
      return;
    let cancelled = false;
    void functionHealth(sdk)
      .then(result => {
        if (cancelled) return;
        if (!functionHealthMatches(result, sdk.parameters.installation)) {
          setFunctionProblem('The saved Function settings changed. Ask a space admin to check app configuration.');
          setFunctionStatus('failed');
        } else setFunctionStatus('ready');
      })
      .catch(error => {
        if (!cancelled) {
          setFunctionProblem(error instanceof Error ? error.message : 'The Function could not be checked.');
          setFunctionStatus('failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  async function open() {
    if (runInProgress.current) return;
    runInProgress.current = true;
    setOpening(true);
    setError('');
    setApplyLines([]);
    setHasOutcome(false);
    try {
      setSnapshot(capture(sdk));
      const run = openTranslator(sdk);
      setOpening(false);
      const lines = await run;
      setSnapshot(capture(sdk));
      if (!lines) return;
      setApplyLines(lines);
      setHasOutcome(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The dialog or draft update failed. Please try again.');
    } finally {
      runInProgress.current = false;
      setOpening(false);
    }
  }

  async function openConfiguration() {
    try {
      if (!(await sdk.access.canEditAppConfig())) {
        setError('A space admin needs to open app configuration.');
        return;
      }
      await sdk.navigator.openAppConfig();
    } catch {
      setError('App configuration could not be opened. Ask a space admin to check this app’s settings.');
    }
  }

  const params = sdk.parameters.installation;
  const configured = isConfigured(params) && (params.transport !== 'function' || functionStatus === 'ready');
  const setupProblem =
    params.transport === 'function'
      ? (functionReadinessError(params) ??
        (functionStatus === 'failed' ? functionProblem : 'Checking the saved Function connection…'))
      : 'AI Translator isn’t set up yet. A space admin needs to connect a translation service.';
  const source =
    snapshot.focusedLocale && snapshot.locales.includes(snapshot.focusedLocale)
      ? snapshot.focusedLocale
      : snapshot.defaultLocale;
  const ready = readyFieldCount(snapshot, source) > 0;
  const applied = applyLines.filter(line => line.status === 'applied').length;
  return (
    <main className="sidebar">
      <Button
        variant="primary"
        isFullWidth
        startIcon={<TranslateIcon />}
        onClick={() => void open()}
        isDisabled={opening || !configured || !ready}
      >
        Translate entry
      </Button>
      {hasOutcome ? (
        <div className="sidebar-results" role="status" aria-live="polite">
          <Note variant={applied ? 'positive' : 'neutral'}>
            {applied} {applied === 1 ? 'value' : 'values'} written to the draft. Nothing was published.
          </Note>
          {applyLines.length > 0 && (
            <ul className="outcome-list" aria-label="Translation outcomes">
              {applyLines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list where one field and locale can have several lines.
                <li key={`${line.key}:${index}`} className={`outcome-${line.status}`}>
                  {line.status === 'applied' ? (
                    <CheckCircleIcon aria-hidden="true" />
                  ) : line.status === 'kept' ? (
                    <MinusIcon aria-hidden="true" />
                  ) : (
                    <WarningIcon aria-hidden="true" />
                  )}
                  <span>{outcomeLine(line, snapshot.definitions, sdk.locales.names)}</span>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="transparent"
            size="small"
            onClick={() => {
              setApplyLines([]);
              setHasOutcome(false);
            }}
          >
            Clear
          </Button>
        </div>
      ) : !configured ? (
        <div className="sidebar-guidance" role="status">
          <p>{setupProblem}</p>
          <Button variant="transparent" size="small" onClick={() => void openConfiguration()}>
            Open app configuration
          </Button>
        </div>
      ) : !ready ? (
        <p className="sidebar-guidance">Nothing to translate yet. Add text to a translatable field first.</p>
      ) : (
        <p className="sidebar-guidance">{readinessLine(snapshot, sdk.locales.names)}</p>
      )}
      {error && (
        <Note variant="negative" role="alert">
          {error}
        </Note>
      )}
    </main>
  );
}
