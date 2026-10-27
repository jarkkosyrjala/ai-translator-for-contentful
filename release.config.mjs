export default {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    './scripts/semantic-release-artifacts.mjs',
    [
      '@semantic-release/github',
      {
        assets: 'artifacts/static-app-bundle-v*.zip',
        successComment: false,
        failComment: false,
        releasedLabels: false,
      },
    ],
  ],
};
