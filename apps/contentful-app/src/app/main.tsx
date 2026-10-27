import {
  type ConfigAppSDK,
  type DialogAppSDK,
  type FieldAppSDK,
  init,
  locations,
  type SidebarAppSDK,
} from '@contentful/app-sdk';
import { createRoot } from 'react-dom/client';
import { Config } from './config';
import { Dialog } from './dialog';
import { EditorDialog, editorDialogType } from './editor-dialogs';
import { Field } from './field';
import { Sidebar } from './sidebar';
import { Standalone } from './standalone';
import type { Params } from './transport-config';
import '@contentful/f36-tokens/dist/css/index.css';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('The app page has no #root element.');

if (window.self === window.top) createRoot(container).render(<Standalone />);
else
  init(sdk => {
    const root = createRoot(container);
    if (sdk.location.is(locations.LOCATION_ENTRY_SIDEBAR)) root.render(<Sidebar sdk={sdk as SidebarAppSDK<Params>} />);
    else if (sdk.location.is(locations.LOCATION_ENTRY_FIELD)) root.render(<Field sdk={sdk as FieldAppSDK<Params>} />);
    else if (sdk.location.is(locations.LOCATION_DIALOG)) {
      const editorDialog = editorDialogType((sdk as DialogAppSDK).parameters.invocation);
      root.render(
        editorDialog ? (
          <EditorDialog sdk={sdk as DialogAppSDK} type={editorDialog} />
        ) : (
          <Dialog sdk={sdk as DialogAppSDK} />
        ),
      );
    } else if (sdk.location.is(locations.LOCATION_APP_CONFIG))
      root.render(<Config sdk={sdk as ConfigAppSDK<Params>} />);
    else root.render(<main>Unsupported app location</main>);
  });
