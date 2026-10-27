export default {
  branches: ['main'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this template.
  tagFormat: 'backend-v${version}',
  plugins: ['./scripts/semantic-release-backend.mjs', ['@semantic-release/npm', { pkgRoot: 'packages/backend/dist' }]],
};
