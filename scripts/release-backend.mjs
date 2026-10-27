import semanticRelease from 'semantic-release';
import config from '../release.backend.config.mjs';

// API options override the project's release.config.mjs. CLI --extends would
// let that app configuration override the backend plugins instead.
await semanticRelease({ ...config, dryRun: process.argv.includes('--dry-run') });
