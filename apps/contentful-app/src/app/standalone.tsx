import { Heading, Note, Paragraph } from '@contentful/f36-components';

// Contentful always loads the app inside a frame. This page appears only when
// the frontend is opened in its own tab, for example to trust the local HTTPS
// certificate for App Dev Mode in Safari.
export function Standalone() {
  return (
    <main className="standalone">
      <Heading as="h1">AI Translator for Contentful</Heading>
      <Paragraph>
        This is the app's frontend. Contentful shows it inside the web app; open an entry in Contentful to translate.
      </Paragraph>
      {import.meta.env.DEV && (
        <Note variant="positive" title="Development server is running">
          {location.protocol === 'https:'
            ? 'This browser accepts its certificate, so Contentful can load it in App Dev Mode.'
            : 'Chrome and Firefox can load it in App Dev Mode. Safari needs HTTPS: run pnpm dev:https.'}
        </Note>
      )}
    </main>
  );
}
